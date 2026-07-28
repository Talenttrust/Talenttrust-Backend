import { z } from 'zod';
import { isSafeUrl } from '../utils/ssrf';


/**
 * Zod schema for environment variable validation.
 * 
 * This schema defines the structure and validation rules for all 
 * required and optional environment variables used by the application.
 * 
 * @security
 *  - Do not log secret values in error messages.
 *  - Use transformations to sanitize inputs.
 */
export const envSchema = z.object({
  // Server Configuration
  PORT: z.string()
    .default('3001')
    .transform((val) => val === '' ? 3001 : parseInt(val, 10))
    .pipe(z.number().int().min(1).max(65535)),

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
    .transform((val) => {
      if (val === undefined || val.trim() === '') return false;
      const lower = val.trim().toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
      return false;
    })
    .pipe(z.boolean()),


  DEBUG: z.string()
    .optional()
    .transform((val) => val === 'true'),

  MAX_REQUEST_SIZE: z.string().default('10mb'),

  CORS_ALLOWED_ORIGINS: z.string()
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      return val.split(',').map(o => o.trim()).filter(Boolean);
    }),

  // Feature Flags
  CONTRACTS_ENABLED: z.string()
    .optional()
    .transform((val) => val !== 'false')
    .pipe(z.boolean()),

  // Database
  DATABASE_URL: z.string().optional(),

  // Secrets
  JWT_SECRET: z.string().optional(), // Required in non-test environments, validated by superRefine
  // Compliance audit HMAC secret – required for proof generation.
  COMPLIANCE_AUDIT_SECRET: z.string()
    .min(32, "COMPLIANCE_AUDIT_SECRET must be at least 32 characters")
    .nonempty("COMPLIANCE_AUDIT_SECRET cannot be empty"),
  // Admin API Key Configuration
  ADMIN_API_KEY: z.string().optional(),
  ADMIN_API_KEY_SCOPES: z.string()
    .optional()
    .transform((val) => val ? val.split(',') : ['deploy:*', '*', 'jobs:admin', 'jobs:*'])
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
    .pipe(z.number().int().positive('STELLAR_RPC_TIMEOUT_MS must be greater than 0').max(120_000)),

  STELLAR_RPC_MAX_RETRIES: z.string()
    .default('3')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(0, 'STELLAR_RPC_MAX_RETRIES must be >= 0').max(10, 'STELLAR_RPC_MAX_RETRIES must be <= 10')),

  STELLAR_RPC_RETRY_BASE_DELAY_MS: z.string()
    .default('200')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().nonnegative('STELLAR_RPC_RETRY_BASE_DELAY_MS must be >= 0').max(60_000)),

   STELLAR_RPC_RETRY_MAX_DELAY_MS: z.string()
     .default('2000')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().nonnegative('STELLAR_RPC_RETRY_MAX_DELAY_MS must be >= 0').max(60_000)),

   // Health Probe Configuration
   QUEUE_FAILED_THRESHOLD: z.string()
     .default('10')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().nonnegative('QUEUE_FAILED_THRESHOLD must be >= 0').max(10_000)),

   QUEUE_BACKLOG_THRESHOLD: z.string()
     .default('100')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().nonnegative('QUEUE_BACKLOG_THRESHOLD must be >= 0').max(1_000_000)),

   QUEUE_PROBE_TIMEOUT_MS: z.string()
     .default('3000')
     .transform((val) => parseInt(val, 10))
     .pipe(z.number().int().positive('QUEUE_PROBE_TIMEOUT_MS must be > 0').max(30_000)),

   // Router / Blue-Green Deployment Configuration
  ACTIVE_COLOR: z.enum(['blue', 'green']).default('blue'),
  BLUE_PORT: z.string().default('3001'),
  GREEN_PORT: z.string().default('3002'),

  // Request Limits Configuration
  MAX_REQUEST_BODY_SIZE: z.string()
    .optional()
    .transform((val) => val === undefined ? undefined : parseInt(val, 10))
    .pipe(z.number().int().nonnegative().optional()),

  ENFORCE_JSON_CONTENT_TYPE: z.string()
    .optional()
    .transform((val) => val === undefined ? undefined : val !== 'false')
    .pipe(z.boolean().optional()),

  ALLOWED_CONTENT_TYPES: z.string()
    .optional()
    .transform((val) => val ? val.split(',').map(ct => ct.trim()) : undefined)
    .pipe(z.array(z.string()).optional()),

  REQUEST_LIMITS_EXCLUDE_PATHS: z.string()
    .optional()
    .transform((val) => val ? val.split(',').map(p => p.trim()) : undefined)
    .pipe(z.array(z.string()).optional()),

  WEBHOOK_DELIVERY_TIMEOUT_MS: z.string()
    .default('10000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(100).max(120_000)),

  WEBHOOK_MAX_PAYLOAD_SIZE_BYTES: z.string()
    .default('1048576')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1024).max(10485760)),

  IDEMPOTENCY_TTL_MS: z.string()
    .optional()
    .transform((val) => val === undefined ? undefined : parseInt(val, 10))
    .pipe(z.number().int().positive().optional()),

  // Disputes Cache Configuration
  DISPUTES_CACHE_TTL_MS: z.string()
    .default('5000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive('DISPUTES_CACHE_TTL_MS must be a positive integer').max(300_000)),

  DISPUTES_CACHE_SWR_MS: z.string()
    .default('30000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().nonnegative('DISPUTES_CACHE_SWR_MS must be >= 0').max(600_000)),

  DISPUTES_CACHE_MAX_ENTRIES: z.string()
    .default('100')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive('DISPUTES_CACHE_MAX_ENTRIES must be a positive integer').max(10000)),

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
    .pipe(z.number().int().positive().max(10000)),

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
      .positive('REPUTATION_DECAY_LAMBDA must be greater than 0')
      .max(1, 'REPUTATION_DECAY_LAMBDA must be less than or equal to 1')),

  REPUTATION_SCORE_ALGORITHM_VERSION: z.string()
    .default('exp-decay-v1'),

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
    .pipe(z.number().int().min(1000).max(120_000)),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string()
    .optional()
    .transform((val) => val === undefined ? undefined : parseInt(val, 10))
    .pipe(z.number().int().min(1).max(65535).optional()),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string()
    .optional()
    .refine((val) => val === undefined || !/[\r\n]/.test(val), {
      message: 'SMTP_FROM must not contain CR/LF characters',
    }),
  SMTP_SECURE: z.string()
    .optional()
    .transform((val) => val === undefined ? undefined : val === 'true'),

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
    .transform((val) => val !== 'false'),

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
    .transform((val) => val !== 'false'),

}).superRefine((obj, ctx) => {
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
export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.errors.map((err) => {
      const path = err.path.join('.');
      // Avoid leaking the actual value in the error message
      return `Field "${path}": ${err.message}`;
    });

    const errorMsg = `Configuration validation failed:\n${errors.join('\n')}`;
    console.error(`[FATAL] ${errorMsg}`);

    // Fail fast with clear error code
    const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID;
    if (!isTest) {
      process.exit(1);
    } else {
      throw new Error(errorMsg);
    }
  }


  return result.data;
}
