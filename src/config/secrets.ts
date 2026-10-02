import * as dotenv from 'dotenv';
import { logger } from '../logger';

// Load .env file
dotenv.config();

/**
 * Represents a secret that can be retrieved and potentially refreshed.
 * This interface allows for rotation-safe handling of secrets.
 */
export interface Secret<T> {
  /**
   * Get the current value of the secret.
   */
  get(): T;

  /**
   * Refresh the secret value from its source (e.g., Environment, Vault, Secrets Manager).
   */
  refresh(): Promise<void>;
}

/**
 * An implementation of Secret that loads from environment variables.
 */
/** Known weak/placeholder secret values that must never be accepted outside development or test. */
const WEAK_SECRET_LITERALS = new Set<string>([
  'dev-secret-keep-it-safe',
  'postgresql://localhost:5432/talenttrust',
]);

/**
 * Options controlling how a secret's default value and validation are
 * applied depending on the current runtime environment.
 */
export interface EnvSecretOptions<T> {
  /** Default value, only ever honored in development/test. */
  defaultValue?: T;
  /** Transform raw string -> T. */
  transform?: (val: string) => T;
  /**
   * When true, this secret is treated as sensitive: its default is
   * refused outside development/test, a minimum length is enforced,
   * and known weak literal values are rejected — even if explicitly set.
   */
  requireStrongInProd?: boolean;
  /** Minimum character length when requireStrongInProd is true. Default: 32. */
  minLength?: number;
}

/**
 * An implementation of Secret that loads from environment variables.
 */
export class EnvSecret<T = string> implements Secret<T> {
  private value!: T;
  private readonly key: string;
  private readonly defaultValue?: T;
  private readonly transform?: (val: string) => T;
  private readonly requireStrongInProd: boolean;
  private readonly minLength: number;

  /**
   * @param key The environment variable key.
   * @param defaultValue Optional default value if the environment variable is missing.
   *   For secrets registered with `requireStrongInProd: true`, this default is
   *   only ever honored in development/test — never in production/staging.
   * @param transform Optional function to transform the raw string value to type T.
   * @param options Optional extra validation behavior (see {@link EnvSecretOptions}).
   */
  constructor(
    key: string,
    defaultValue?: T,
    transform?: (val: string) => T,
    options?: Omit<EnvSecretOptions<T>, 'defaultValue' | 'transform'>,
  ) {
    this.key = key;
    this.defaultValue = defaultValue;
    this.transform = transform;
    this.requireStrongInProd = options?.requireStrongInProd ?? false;
    this.minLength = options?.minLength ?? 32;
    this.load();
  }


  private isDevOrTest(): boolean {
    const env = process.env.NODE_ENV ?? 'development';
    return env === 'development' || env === 'test';
  }


  /**
   * Loads the secret value from the environment variable.
   *
   * @remarks
   * **Security — transform error redaction guarantee**:
   * If the `transform` callback throws for any reason, the thrown error
   * message contains **only the environment-variable key name** — never the
   * raw protected value, any substring of it, nor any message derived from the
   * original thrown value.
   *
   * This guarantee is unconditional:
   * - If transform throws an `Error` whose `.message` echoes its input
   *   (e.g. a JSON/YAML parser), that message is discarded.
   * - If transform throws a plain `string` (e.g. `throw rawValue`), that
   *   string is discarded.
   * - If transform throws any other non-Error value, it is discarded.
   *
   * The catch block intentionally uses the catch-all `catch {` form
   * (no binding) to make it impossible to accidentally reference the
   * original error or the raw protected value.
   *
   * The resulting error message is safe to write to any log sink, including
   * `src/logger.ts`, without further redaction.
   */

  private load(): void {
    const rawValue = process.env[this.key];

    if (rawValue === undefined) {
      // Defaults for sensitive secrets are dev/test-only, no matter what
      // the caller passed in — this is the fail-fast guarantee that
      // prevents a forgotten env var from silently falling back to a
      // known, committed value in production.
      if (this.defaultValue !== undefined && (!this.requireStrongInProd || this.isDevOrTest())) {
        this.value = this.defaultValue;
        return;
      }
      throw new Error(`Configuration Error: Missing required secret "${this.key}"`);
    }

    if (this.requireStrongInProd && !this.isDevOrTest()) {
      if (WEAK_SECRET_LITERALS.has(rawValue)) {
        logger.warn('SecretsManager: rejected known weak secret literal', { key: this.key });
        throw new Error(`Configuration Error: Secret "${this.key}" is set to a known weak/placeholder value and must be changed`);
      }
      if (rawValue.length < this.minLength) {
        logger.warn('SecretsManager: rejected secret below minimum length', { key: this.key, minLength: this.minLength });
        throw new Error(`Configuration Error: Secret "${this.key}" must be at least ${this.minLength} characters`);
      }
    }

    try {
      this.value = this.transform ? this.transform(rawValue) : (rawValue as unknown as T);
    } catch {
      // Never include the original error message or any derivative of the raw
      // secret value in the thrown error — a thrown parser error can echo its
      // input.  Only the key name is safe to surface here.
      throw new Error(
        `Configuration Error: Failed to transform credential "${this.key}" — details omitted`
      );
    }
  }

  /**
   * Returns the current secret value.
   */
  get(): T {
    return this.value;
  }

  /**
   * Refreshes the secret value by re-reading the environment variable.
   * Note: In a production environment with rotation (like AWS Secrets Manager), 
   * this would involve an asynchronous API call to fetch the latest version.
   */
  async refresh(): Promise<void> {
    // For environment variables, we just re-load. 
    // If process.env was updated externally (e.g., via some watcher), this would pick it up.
    this.load();
  }
}

/**
 * Manager class for handling multiple secrets and providing a unified interface.
 */
export class SecretsManager {
  private secrets: Map<string, Secret<any>> = new Map();

  /**
   * Register a secret with the manager.
   */
  register<T>(name: string, secret: Secret<T>): void {
    if (this.secrets.has(name)) {
      throw new Error(`SecretsManager Error: Secret "${name}" is already registered.`);
    }
    this.secrets.set(name, secret);
  }

  /**
   * Get a registered secret by name.
   */
  get<T>(name: string): Secret<T> {
    const secret = this.secrets.get(name);
    if (!secret) {
      throw new Error(`SecretsManager Error: Secret "${name}" not found.`);
    }
    return secret;
  }

  /**
   * Get the current value of a secret directly.
   */
  getValue<T>(name: string): T {
    return this.get<T>(name).get();
  }

  /**
   * Refresh all registered secrets.
   */
  async refreshAll(): Promise<void> {
    const promises = Array.from(this.secrets.values()).map((s) => s.refresh());
    await Promise.all(promises);
  }

  /**
   * Clear all registered secrets (useful for testing).
   */
  clear(): void {
    this.secrets.clear();
  }
}

/**
 * Default instance of SecretsManager for the application.
 */
export const secretsManager = new SecretsManager();

/**
 * Initialize core application secrets.
 * This should be called early in the application lifecycle.
 * 
 * @remarks
 * - Secrets with defaults are for development only and must be overridden in production.
 * - `DATABASE_URL` and `JWT_SECRET` are required in production.
 */
export function initializeSecrets(): void {
  // Clear any existing registrations to avoid "already registered" errors on re-init
  secretsManager.clear();

  // Register common secrets
  secretsManager.register('PORT', new EnvSecret<number>('PORT', 3001, (v) => parseInt(v, 10)));
  secretsManager.register('NODE_ENV', new EnvSecret('NODE_ENV', 'development'));

  // These have defaults for development/test only. Outside those environments,
  // a missing value throws at boot (fail-fast) instead of silently falling
  // back to a value that is committed to source control.
  secretsManager.register(
    'DATABASE_URL',
    new EnvSecret('DATABASE_URL', 'postgresql://localhost:5432/talenttrust', undefined, {
      requireStrongInProd: true,
      minLength: 1, // DATABASE_URL just needs to be present outside dev/test, not "strong" per se
    }),
  );
  secretsManager.register(
    'JWT_SECRET',
    new EnvSecret('JWT_SECRET', 'dev-secret-keep-it-safe', undefined, {
      requireStrongInProd: true,
      minLength: 32,
    }),
  );
}

// Self-initialize on module load for convenience, but can be called again if needed.
initializeSecrets();

/**
 * RotatingSecret fetches a secret value from an asynchronous provider and
 * caches the last successful value.  It exposes the same synchronous
 * `get()` contract as other `Secret` implementations while making
 * `refresh()` perform the real asynchronous fetch.
 *
 * On refresh errors the previous value is retained (fail-safe) and no
 * secret material is ever written to logs. A refresh interval can be
 * supplied to enable background polling.
 */
export class RotatingSecret<T = string> implements Secret<T> {
  private value?: T;
  private readonly provider: () => Promise<string>;
  private readonly transform?: (val: string) => T;
  private timer?: NodeJS.Timeout;
  private readonly name?: string;

  /**
   * @param opts.provider Async function that returns the raw secret string.
   * @param opts.defaultValue Optional default value used until the first
   *                          successful fetch.
   * @param opts.transform Optional transform from raw string to `T`.
   * @param opts.refreshIntervalMs Optional background refresh interval.
   * @param opts.name Optional name used in non-sensitive logs/messages.
   */
  constructor(opts: {
    provider: () => Promise<string>;
    defaultValue?: T;
    transform?: (val: string) => T;
    refreshIntervalMs?: number;
    name?: string;
  }) {
    this.provider = opts.provider;
    this.transform = opts.transform;
    this.name = opts.name;
    if (opts.defaultValue !== undefined) {
      this.value = opts.defaultValue;
    }

    if (opts.refreshIntervalMs && opts.refreshIntervalMs > 0) {
      this.timer = setInterval(() => {
        // fire-and-forget background refresh; failures are tolerated
        this.refresh().catch(() => {
          // Intentionally quiet: refresh() already logs a minimal message
        });
      }, opts.refreshIntervalMs);
    }
  }

  get(): T {
    if (this.value === undefined) {
      throw new Error(`Configuration Error: Missing rotated secret${this.name ? ` \"${this.name}\"` : ''}`);
    }
    return this.value as T;
  }

  async refresh(): Promise<void> {
    try {
      const raw = await this.provider();
      const newVal = this.transform ? this.transform(raw) : (raw as unknown as T);
      this.value = newVal;
    } catch {
      // Do not log secret values. Log only that refresh failed and include
      // the secret name for context. Preserve previous value (fail-safe).
      try {
        logger.warn('SecretsManager: failed to refresh secret', { name: this.name });
      } catch {
        // Swallow any logging errors; we must not surface secrets here.
      }
    }
  }

  /**
   * Stop any background refresh timer. Useful for tests/cleanup.
   */
  stopAutoRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
