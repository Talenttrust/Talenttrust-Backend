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
  API_BASE_URL: z.string().url().refine(val => {
    if (process.env.SSRF_ALLOW_PRIVATE_HOSTS === 'true') return true;
    return isSafeUrl(val);
  }, {
    message: "API_BASE_URL must be a public URL and cannot point to internal resources (SSRF protection)"
  }).optional(),


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

  // Stellar/Soroban Configuration
  STELLAR_HORIZON_URL: z.string().url()
    .refine(val => {
      if (process.env.SSRF_ALLOW_PRIVATE_HOSTS === 'true') return true;
      return isSafeUrl(val);
    }, {
      message: "STELLAR_HORIZON_URL must be a public URL and cannot point to internal resources (SSRF protection)"
    })
    .default('https://horizon-testnet.stellar.org'),


  STELLAR_NETWORK_PASSPHRASE: z.string()
    .default('Test SDF Network ; September 2015'),

  SOROBAN_RPC_URL: z.string().url()
    .refine(val => {
      if (process.env.SSRF_ALLOW_PRIVATE_HOSTS === 'true') return true;
      return isSafeUrl(val);
    }, {
      message: "SOROBAN_RPC_URL must be a public URL and cannot point to internal resources (SSRF protection)"
    })
    .default('https://soroban-testnet.stellar.org'),


  SOROBAN_CONTRACT_ID: z.string().optional(),

  STELLAR_RPC_URL: z.string().url()
    .refine(val => {
      if (process.env.SSRF_ALLOW_PRIVATE_HOSTS === 'true') return true;
      return isSafeUrl(val);
    }, {
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

  IDEMPOTENCY_TTL_MS: z.string()
    .optional()
    .transform((val) => val === undefined ? undefined : parseInt(val, 10))
    .pipe(z.number().int().positive().optional()),

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

  // Reputation Scoring Configuration
  REPUTATION_DECAY_LAMBDA: z.string()
    .default('0.005')
    .transform((val) => parseFloat(val))
    .pipe(z.number()
      .positive('REPUTATION_DECAY_LAMBDA must be greater than 0')
      .max(1, 'REPUTATION_DECAY_LAMBDA must be less than or equal to 1')),

  REPUTATION_SCORE_ALGORITHM_VERSION: z.string()
    .default('exp-decay-v1'),

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
