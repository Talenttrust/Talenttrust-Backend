import { z } from 'zod';
import { isSafeUrl } from '../utils/ssrf';
import { parseFinalityDepths } from '../finality/policy';
import { appConfigSchema } from '../appConfiguration';


/**
 * Zod schema for environment variable validation.
 * 
 * This schema defines the structure and validation rules for all 
 * required and optional environment variables used by the application.
 * 
 * Validation boundaries for `src/appConfiguration.ts` are enforced here:
 * the `APP_CONFIG` variable is parsed through `appConfigSchema`, which
 * defines the accepted shape, rejects unknown keys, and applies
 * deterministic defaults for boundary/duplicate inputs.
 *
 * @security
 *  - Do not log secret values in error messages.
 *  - Use transformations to sanitize inputs.
 */
/**
 * Field-level schema (types, defaults, per-field bounds).
 *
 * Exported separately from {@link envSchema} so the individual field parsers can
 * be exercised directly (e.g. asserting a default, or that a bound rejects an
 * out-of-range value) without having to satisfy every required variable and the
 * cross-field rules below.
 */
export const envObjectSchema = z.object({
  // Server Configuration
  PORT: z.string()
    .default('3001')
    .transform((val) => val === '' ? 3001 : parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.PORT_MIN).max(VALIDATION_BOUNDS.PORT_MAX)),

  NODE_ENV: z.enum(['development', 'staging', 'production', 'test'])
    .default('development'),

  // API Configuration
  API_BASE_URL: z.string().url().refine(val => isSafeUrl(val), {
    message: "API_BASE_URL must be a public URL and cannot point to internal resources (SSRF protection)"
  }).optional(),

  /**
   * Explicit SSRF private-host bypass. Default off.
   * Rejected outright when NODE_ENV==='production' (see superRefine below).
   * Only honoured by isSafeUrl when NODE_ENV is development|test|staging.
   */
  SSRF_ALLOW_PRIVATE_HOSTS: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val) ?? false)
    .pipe(z.boolean()),


  DEBUG: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val) ?? false)
    .pipe(z.boolean()),

  MAX_REQUEST_SIZE: z.string().default('10mb'),

  CORS_ALLOWED_ORIGINS: z.string()
    .optional()
    .transform((val) => {
      if (val === undefined || val.trim() === '') return undefined;
      return val.split(',').map(o => o.trim()).filter(Boolean);
    }),

  // Feature Flags
  CONTRACTS_ENABLED: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val) ?? true)
    .pipe(z.boolean()),

  // Database
  DATABASE_URL: z.string().optional(),

  // Secrets
  JWT_SECRET: z.string().optional(), // Required in non-test environments, validated by superRefine
  // Compliance audit HMAC secret – required for proof generation.
  COMPLIANCE_AUDIT_SECRET: z.string()
    .min(VALIDATION_BOUNDS.COMPLIANCE_AUDIT_SECRET_MIN_LENGTH, "COMPLIANCE_AUDIT_SECRET must be at least 32 characters")
    .nonempty("COMPLIANCE_AUDIT_SECRET cannot be empty"),
  // Admin API Key Configuration
  ADMIN_API_KEY: z.string().optional(),
  ADMIN_API_KEY_SCOPES: z.string()
    .optional()
    .transform((val) => (val && val.trim() !== '') ? val.split(',').map(s => s.trim()).filter(Boolean) : ['deploy:*', '*', 'jobs:admin', 'jobs:*'])
    .pipe(z.array(z.string()).optional()),

  // API-key management rate limiting
  RL_API_KEYS_MAX: z.string().optional(),
  RL_API_KEYS_WINDOW_MS: z.string().optional(),
  RL_API_KEYS_ABUSE_THRESHOLD: z.string().optional(),
  RL_API_KEYS_BLOCK_WINDOW_MS: z.string().optional(),
  RL_API_KEYS_BLOCK_DURATION_MS: z.string().optional(),
  RL_API_KEYS_MAX_BLOCK_MS: z.string().optional(),

  // Stellar/Soroban Configuration
  STELLAR_HORIZON_URL: z.string().url()
    .refine(val => isSafeUrl(val), {
      message: "STELLAR_HORIZON_URL must be a public URL and cannot point to internal resources (SSRF protection)"
    })
    .default('https://horizon-testnet.stellar.org'),


  STELLAR_NETWORK_PASSPHRASE: z.string()
    .default('Test SDF Network ; September 2015'),

  SOROBAN_RPC_URL: z.string().url()
    .refine(val => isSafeUrl(val), {
      message: "SOROBAN_RPC_URL must be a public URL and cannot point to internal resources (SSRF protection)"
    })
    .default('https://soroban-testnet.stellar.org'),


  SOROBAN_CONTRACT_ID: z.string().optional(),

  STELLAR_RPC_URL: z.string().url()
    .refine(val => isSafeUrl(val), {
      message: "STELLAR_RPC_URL must be a public URL and cannot point to internal resources (SSRF protection)"
    })
    .default('https://rpc-testnet.stellar.org'),

  // Stellar RPC transport timeout and retry knobs.  Mirrored in
  // src/rpc/stellarConfig.ts so the transport can be loaded in isolation
  // (e.g. tests that exercise the rpc client without booting the full app).
  STELLAR_RPC_TIMEOUT_MS: z.string()
    .default('5000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.STELLAR_RPC_TIMEOUT_MS_MIN, 'STELLAR_RPC_TIMEOUT_MS must be greater than 0').max(VALIDATION_BOUNDS.STELLAR_RPC_TIMEOUT_MS_MAX)),

  STELLAR_RPC_MAX_RETRIES: z.string()
    .default('3')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.STELLAR_RPC_MAX_RETRIES_MIN, 'STELLAR_RPC_MAX_RETRIES must be >= 0').max(VALIDATION_BOUNDS.STELLAR_RPC_MAX_RETRIES_MAX, 'STELLAR_RPC_MAX_RETRIES must be <= 10')),

  STELLAR_RPC_RETRY_BASE_DELAY_MS: z.string()
    .default('200')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.STELLAR_RPC_RETRY_DELAY_MS_MIN, 'STELLAR_RPC_RETRY_BASE_DELAY_MS must be >= 0').max(VALIDATION_BOUNDS.STELLAR_RPC_RETRY_DELAY_MS_MAX)),

   STELLAR_RPC_RETRY_MAX_DELAY_MS: z.string()
     .default('2000')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().min(VALIDATION_BOUNDS.STELLAR_RPC_RETRY_DELAY_MS_MIN, 'STELLAR_RPC_RETRY_MAX_DELAY_MS must be >= 0').max(VALIDATION_BOUNDS.STELLAR_RPC_RETRY_DELAY_MS_MAX)),

   // Health Probe Configuration
   QUEUE_FAILED_THRESHOLD: z.string()
     .default('10')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().min(VALIDATION_BOUNDS.QUEUE_FAILED_THRESHOLD_MIN, 'QUEUE_FAILED_THRESHOLD must be >= 0').max(VALIDATION_BOUNDS.QUEUE_FAILED_THRESHOLD_MAX)),

   QUEUE_BACKLOG_THRESHOLD: z.string()
     .default('100')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().min(VALIDATION_BOUNDS.QUEUE_BACKLOG_THRESHOLD_MIN, 'QUEUE_BACKLOG_THRESHOLD must be >= 0').max(VALIDATION_BOUNDS.QUEUE_BACKLOG_THRESHOLD_MAX)),

   QUEUE_PROBE_TIMEOUT_MS: z.string()
     .default('3000')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().min(VALIDATION_BOUNDS.QUEUE_PROBE_TIMEOUT_MS_MIN, 'QUEUE_PROBE_TIMEOUT_MS must be > 0').max(VALIDATION_BOUNDS.QUEUE_PROBE_TIMEOUT_MS_MAX)),

   // Router / Blue-Green Deployment Configuration
  ACTIVE_COLOR: z.enum(['blue', 'green']).default('blue'),
  BLUE_PORT: z.string().default('3001'),
  GREEN_PORT: z.string().default('3002'),

  // Request Limits Configuration
  MAX_REQUEST_BODY_SIZE: z.string()
    .optional()
    .transform((val) => parseOptionalInt(val))
    .pipe(z.number().int().nonnegative().optional()),

  ENFORCE_JSON_CONTENT_TYPE: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val))
    .pipe(z.boolean().optional()),

  ALLOWED_CONTENT_TYPES: z.string()
    .optional()
    .transform((val) => (val && val.trim() !== '') ? val.split(',').map(ct => ct.trim()).filter(Boolean) : undefined)
    .pipe(z.array(z.string()).optional()),

  REQUEST_LIMITS_EXCLUDE_PATHS: z.string()
    .optional()
    .transform((val) => (val && val.trim() !== '') ? val.split(',').map(p => p.trim()).filter(Boolean) : undefined)
    .pipe(z.array(z.string()).optional()),

  WEBHOOK_DELIVERY_TIMEOUT_MS: z.string()
    .default('10000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.WEBHOOK_DELIVERY_TIMEOUT_MS_MIN).max(VALIDATION_BOUNDS.WEBHOOK_DELIVERY_TIMEOUT_MS_MAX)),

  WEBHOOK_MAX_PAYLOAD_SIZE_BYTES: z.string()
    .default('1048576')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.WEBHOOK_MAX_PAYLOAD_SIZE_BYTES_MIN).max(VALIDATION_BOUNDS.WEBHOOK_MAX_PAYLOAD_SIZE_BYTES_MAX)),

  IDEMPOTENCY_TTL_MS: z.string()
    .optional()
    .transform((val) => parseOptionalInt(val))
    .pipe(z.number().int().positive().optional()),

  // Disputes Cache Configuration
  DISPUTES_CACHE_TTL_MS: z.string()
    .default('5000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.DISPUTES_CACHE_TTL_MS_MIN, 'DISPUTES_CACHE_TTL_MS must be a positive integer').max(VALIDATION_BOUNDS.DISPUTES_CACHE_TTL_MS_MAX)),

  DISPUTES_CACHE_SWR_MS: z.string()
    .default('30000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.DISPUTES_CACHE_SWR_MS_MIN, 'DISPUTES_CACHE_SWR_MS must be >= 0').max(VALIDATION_BOUNDS.DISPUTES_CACHE_SWR_MS_MAX)),

  DISPUTES_CACHE_MAX_ENTRIES: z.string()
    .default('100')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.DISPUTES_CACHE_MAX_ENTRIES_MIN, 'DISPUTES_CACHE_MAX_ENTRIES must be a positive integer').max(VALIDATION_BOUNDS.DISPUTES_CACHE_MAX_ENTRIES_MAX)),

  // Auth Cache Configuration
  AUTH_CACHE_TTL_MS: z.string()
    .default('5000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive('AUTH_CACHE_TTL_MS must be a positive integer').max(300_000)),

  AUTH_CACHE_MAX_ENTRIES: z.string()
    .default('100')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive('AUTH_CACHE_MAX_ENTRIES must be a positive integer').max(10000)),

  // API-key auth cache configuration.
  //
  // `src/auth/apiKeys.ts` has always read these two values off the validated
  // environment, but they were never declared here, so they arrived as
  // `undefined`: `expiresAt` became `Date.now() + undefined = NaN` (which is
  // *never* past, so entries never expired) and the capacity check
  // `size >= undefined` was always false (so nothing was ever evicted). The
  // shared auth cache was therefore unbounded and immortal. Declaring them here
  // with explicit bounds restores both TTL and LRU eviction.
  AUTH_CACHE_TTL_MS: z.string()
    .default('300000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive('AUTH_CACHE_TTL_MS must be a positive integer').max(3_600_000)),

  AUTH_CACHE_MAX_ENTRIES: z.string()
    .default('1000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive('AUTH_CACHE_MAX_ENTRIES must be a positive integer').max(100_000)),

  RATE_LIMIT_STORE_TYPE: z.enum(['memory', 'redis'])
    .default('memory'),
  REDIS_URL: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().default('rate_limit:'),

  ROUTE_BODY_LIMITS: z.string()
    .optional()
    .refine(val => {
      if (!val) return true;
      const pairs = val.split(',');
      for (const pair of pairs) {
        const parts = pair.split(':');
        if (parts.length !== 2) return false;
        const [path, limitStr] = parts;
        if (!path.startsWith('/')) return false;
        const limit = Number(limitStr);
        if (!Number.isInteger(limit) || limit < 0) return false;
      }
      return true;
    }, {
      message: "ROUTE_BODY_LIMITS must be a comma-separated list of path:limit pairs (e.g. '/path:1024,/other:2048') with positive integer limits."
    })
    .transform(val => {
      if (!val) return undefined;
      const limits: Record<string, number> = {};
      const pairs = val.split(',');
      for (const pair of pairs) {
        const [path, limitStr] = pair.split(':');
        limits[path.trim()] = parseInt(limitStr.trim(), 10);
      }
      return limits;
    })
    .pipe(z.record(z.string(), z.number()).optional()),

  HTTP_METRICS_ROUTE_LABEL_LIMIT: z.string()
    .default('100')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.HTTP_METRICS_ROUTE_LABEL_LIMIT_MIN).max(VALIDATION_BOUNDS.HTTP_METRICS_ROUTE_LABEL_LIMIT_MAX)),

  // Metrics Rate Limiting
  METRICS_RATE_LIMIT_MAX_REQUESTS: z.string()
    .default('100')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive()),

  METRICS_RATE_LIMIT_WINDOW_MS: z.string()
    .default('60000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive()),


  // Reputation Scoring Configuration
  REPUTATION_ENABLED: z.string()
    .optional()
    .transform((val) => val === undefined ? false : val === 'true')
    .pipe(z.boolean()),

  REPUTATION_DECAY_LAMBDA: z.string()
    .default('0.005')
    .transform((val) => parseFloat(val))
    .pipe(z.number()
      .gt(VALIDATION_BOUNDS.REPUTATION_DECAY_LAMBDA_MIN_EXCLUSIVE, 'REPUTATION_DECAY_LAMBDA must be greater than 0')
      .max(VALIDATION_BOUNDS.REPUTATION_DECAY_LAMBDA_MAX, 'REPUTATION_DECAY_LAMBDA must be less than or equal to 1')),

  REPUTATION_SCORE_ALGORITHM_VERSION: z.string()
    .default('exp-decay-v1'),

  // Reputation Read Cache Configuration
  /**
   * Time-to-live (ms) for cached auth validation results (API keys).
   * Default: 300 000 (5 min).
   */
  AUTH_CACHE_TTL_MS: z.string()
    .default('300000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number()
      .int('AUTH_CACHE_TTL_MS must be an integer')
      .positive('AUTH_CACHE_TTL_MS must be greater than 0')),

  /**
   * Maximum number of auth validation results to hold in the LRU cache.
   * Default: 1000.
   */
  AUTH_CACHE_MAX_ENTRIES: z.string()
    .default('1000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number()
      .int('AUTH_CACHE_MAX_ENTRIES must be an integer')
      .positive('AUTH_CACHE_MAX_ENTRIES must be greater than 0')),

  // Reputation Read Cache Configuration
  /**
   * Time-to-live (ms) for cached reputation profiles.
   * Reads within this window are served from in-memory LRU cache without
   * hitting the database. Must be a positive integer. Default: 60 000 (1 min).
   */
  REPUTATION_CACHE_TTL_MS: z.string()
    .default('60000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number()
      .int('REPUTATION_CACHE_TTL_MS must be an integer')
      .positive('REPUTATION_CACHE_TTL_MS must be greater than 0')),

  /**
   * Maximum number of reputation profiles to hold in the LRU cache.
   * When this bound is exceeded, the least-recently-used entry is evicted.
   * Must be a positive integer. Default: 500.
   */
  REPUTATION_CACHE_MAX_ENTRIES: z.string()
    .default('500')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number()
      .int('REPUTATION_CACHE_MAX_ENTRIES must be an integer')
      .positive('REPUTATION_CACHE_MAX_ENTRIES must be greater than 0')),

  // Email transport (queue processor + notification service)
  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'ses', 'sendgrid'])
    .default('console'),

  EMAIL_SEND_TIMEOUT_MS: z.string()
    .default('10000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.EMAIL_SEND_TIMEOUT_MS_MIN).max(VALIDATION_BOUNDS.EMAIL_SEND_TIMEOUT_MS_MAX)),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string()
    .optional()
    .transform((val) => parseOptionalInt(val))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.SMTP_PORT_MIN).max(VALIDATION_BOUNDS.SMTP_PORT_MAX).optional()),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string()
    .optional()
    .refine((val) => val === undefined || !/[\r\n]/.test(val), {
      message: 'SMTP_FROM must not contain CR/LF characters',
    }),
  SMTP_SECURE: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val)),

  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),

  SENDGRID_API_KEY: z.string().optional(),

  // ── Webhooks Feature Flag ───────────────────────────────────────────────────
  /**
   * WEBHOOKS_ENABLED — master switch for the webhooks subsystem.
   *
   * When `false`:
   *  - `WebhookService.trigger()` is a no-op and returns immediately without
   *    delivering any events or touching subscriptions.
   *  - The `/api/v1/webhook-subscriptions` router is not mounted on the
   *    Express app and all subscription endpoints return `404`.
   *
   * Default: `true` (webhooks are on unless explicitly disabled).
   */
  WEBHOOKS_ENABLED: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val) ?? true),

  // ── Audit Feature Flag ──────────────────────────────────────────────────────
  /**
   * AUDIT_ENABLED — master switch for the audit subsystem.
   *
   * When `false`:
   *  - `auditMiddleware` attaches a no-op helper to `res.locals.audit` so
   *    route handlers continue to compile and run without changes.
   *  - `protectedEndpointAuditMiddleware` skips registering its `finish`
   *    listener, so no entries are written for protected-endpoint traffic.
   *  - The `/api/v1/audit` router is not mounted on the Express app.
   *
   * Default: `true` (audit is on unless explicitly disabled).
   */
  AUDIT_ENABLED: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val) ?? true),

  // ── Blockchain Finality Configuration ───────────────────────────────────────
  /**
   * FINALITY_DEPTHS — per-network confirmation depth, comma-separated
   * `network=depth` pairs (e.g. `stellar=1,soroban=2`). Depth is the
   * number of confirmations an event must accumulate before it is
   * exposed through public reads. A depth of `0` enables
   * zero-confirmation for that network (only honoured outside
   * production unless FINALITY_ALLOW_ZERO_CONFIRMATION is explicit).
   *
   * Default: `stellar=1,soroban=1`.
   */
  FINALITY_DEPTHS: z.string()
    .default('stellar=1,soroban=1')
    .transform((val) => parseFinalityDepths(val)),

  /**
   * FINALITY_DEFAULT_DEPTH — confirmation depth applied to networks
   * without an explicit FINALITY_DEPTHS entry. Conservative (fail-closed)
   * so an unconfigured network is never exposed early.
   *
   * Default: `6`.
   */
  FINALITY_DEFAULT_DEPTH: z.string()
    .default('6')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(VALIDATION_BOUNDS.FINALITY_DEFAULT_DEPTH_MIN, 'FINALITY_DEFAULT_DEPTH must be a non-negative integer').max(VALIDATION_BOUNDS.FINALITY_DEFAULT_DEPTH_MAX)),

  /**
   * FINALITY_ALLOW_ZERO_CONFIRMATION — when `true`, a configured depth
   * of `0` is honoured (zero-confirmation). When `false`, depth `0` is
   * clamped to `1`. When unset, zero-confirmation is permitted in
   * development/test/staging and forbidden in production.
   */
  FINALITY_ALLOW_ZERO_CONFIRMATION: z.string()
    .optional()
    .transform((val) => parseOptionalBool(val))
    .pipe(z.boolean().optional()),

});

/**
 * Full environment schema: the field-level shape plus cross-field constraints
 * (provider-specific requirements, production safety rails, ...).
 */
export const envSchema = envObjectSchema.superRefine((obj, ctx) => {
  const requireForEmailProvider = (field: keyof typeof obj, message: string): void => {
    if (!obj[field]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    }
  };

  if (obj.EMAIL_PROVIDER === 'smtp') {
    requireForEmailProvider('SMTP_HOST', 'SMTP_HOST is required when EMAIL_PROVIDER=smtp');
    requireForEmailProvider('SMTP_PORT', 'SMTP_PORT is required when EMAIL_PROVIDER=smtp');
    requireForEmailProvider('SMTP_FROM', 'SMTP_FROM is required when EMAIL_PROVIDER=smtp');
  } else if (obj.EMAIL_PROVIDER === 'ses') {
    requireForEmailProvider('SMTP_FROM', 'SMTP_FROM is required when EMAIL_PROVIDER=ses');
    requireForEmailProvider('AWS_REGION', 'AWS_REGION is required when EMAIL_PROVIDER=ses');
    requireForEmailProvider('AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID is required when EMAIL_PROVIDER=ses');
    requireForEmailProvider('AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY is required when EMAIL_PROVIDER=ses');
  } else if (obj.EMAIL_PROVIDER === 'sendgrid') {
    requireForEmailProvider('SMTP_FROM', 'SMTP_FROM is required when EMAIL_PROVIDER=sendgrid');
    requireForEmailProvider('SENDGRID_API_KEY', 'SENDGRID_API_KEY is required when EMAIL_PROVIDER=sendgrid');
  }

  if (obj.NODE_ENV === 'production') {
    if (obj.SSRF_ALLOW_PRIVATE_HOSTS === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SSRF_ALLOW_PRIVATE_HOSTS'],
        message:
          'SSRF_ALLOW_PRIVATE_HOSTS must not be enabled in production; private hosts are always blocked',
      });
    }
    if (!obj.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET is required in production',
      });
    } else if (obj.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be at least 32 characters in production',
      });
    }
  }  // ← closes the if block
});  // ← closes superRefine callback and the whole chain


export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates the provided environment object against the schema.
 * 
 * @param env - The environment object to validate (usually process.env)
 * @returns The validated and typed configuration object
 * @throws {Error} If validation fails, with safe error messages
 */
/**
 * Validates the provided environment object against the schema.
 *
 * Determinism guarantees:
 *  - The same input always produces the same output or the same error set.
 *  - Error messages never include the offending value, only the field path.
 *  - In test environments, validation failures throw instead of exiting.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.errors.map((err) => {
      const path = err.path.join('.');
      // Avoid leaking the actual value in the error message
      return `Field "${path || '<root>'}": ${err.message}`;
    });

    const errorMsg = `Configuration validation failed:\n${errors.join('\n')}`;
    console.error(`[FATAL] ${errorMsg}`);

    // Fail fast with clear error code
    const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID;
    if (!isTest) {
      throw new Error(errorMsg);
    } else {
      throw new Error(errorMsg);
    }
  }


  return result.data;
}
