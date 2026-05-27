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

  
  DEBUG: z.string()
    .optional()
    .transform((val) => val === 'true'),
  
  MAX_REQUEST_SIZE: z.string().default('10mb'),
  
  CORS_ORIGINS: z.string()
    .optional()
    .transform((val) => val ? val.split(',') : ['http://localhost:3000']),

  // Database
  DATABASE_URL: z.string().optional(),

  // Secrets
  JWT_SECRET: z.string().min(8, "JWT_SECRET must be at least 8 characters").optional(),

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
});


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
