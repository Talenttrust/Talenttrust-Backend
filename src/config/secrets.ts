import * as dotenv from 'dotenv';

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
export class EnvSecret<T = string> implements Secret<T> {
  private value!: T;
  private readonly key: string;
  private readonly defaultValue?: T;
  private readonly transform?: (val: string) => T;

  /**
   * @param key The environment variable key.
   * @param defaultValue Optional default value if the environment variable is missing.
   * @param transform Optional function to transform the raw string value to type T.
   */
  constructor(key: string, defaultValue?: T, transform?: (val: string) => T) {
    this.key = key;
    this.defaultValue = defaultValue;
    this.transform = transform;
    this.load();
  }

  private load(): void {
    const rawValue = process.env[this.key];
    if (rawValue === undefined) {
      if (this.defaultValue !== undefined) {
        this.value = this.defaultValue;
        return;
      }
      throw new Error(`Configuration Error: Missing required secret "${this.key}"`);
    }

    try {
      this.value = this.transform ? this.transform(rawValue) : (rawValue as unknown as T);
    } catch (error) {
      throw new Error(`Configuration Error: Failed to transform secret "${this.key}": ${error instanceof Error ? error.message : String(error)}`);
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
 */
export function initializeSecrets(): void {
  // Clear any existing registrations to avoid "already registered" errors on re-init
  secretsManager.clear();

  // Register common secrets
  secretsManager.register('PORT', new EnvSecret<number>('PORT', 3001, (v) => parseInt(v, 10)));
  secretsManager.register('NODE_ENV', new EnvSecret('NODE_ENV', 'development'));
  
  // These would typically be required in production but can have defaults for development
  secretsManager.register('DATABASE_URL', new EnvSecret('DATABASE_URL', 'postgresql://localhost:5432/talenttrust'));
  secretsManager.register('JWT_SECRET', new EnvSecret('JWT_SECRET', 'dev-secret-keep-it-safe'));
}

// Self-initialize on module load for convenience, but can be called again if needed.
initializeSecrets();
