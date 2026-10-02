/**
 * Environment variable parsing and validation utilities.
 *
 * These functions provide type-safe access to environment variables with
 * validation, default values, and descriptive error messages on failure.
 * Empty strings are treated as missing values.
 *
 * Validation boundaries:
 * - Missing / empty / whitespace-only values are treated as undefined.
 * - Values are trimmed before return, so surrounding whitespace is never
 *   part of the returned value.
 * - Integer parsing rejects non-numeric, non-finite, and non-integer input.
 * - Boolean parsing accepts only true/1/false/0 (case-insensitive).
 * - All failures throw Error with the variable name and the offending raw
 *   value so failures are diagnosable without exposing secrets from other
 *   variables.
 * @module
 */

/**
 * Key suffixes whose values must never be included in error messages.
 * This keeps failures diagnosable without leaking secrets into logs.
 */
const SENSITIVE_KEY_SUFFIXES = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSPHRASE',
  'CREDS',
  'CREDENTIAL',
  'KEY',
  'PRIVATE',
  'APIKEY',
  'API_KEY',
  'SALE',
] as const;

/**
 * Determines whether an environment variable name looks sensitive.
 *
 * @param key - Environment variable name
 * @returns true if the key name suggests a secret value
 */
function isSensitiveKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => upper.includes(suffix));
}

/**
 * Redacts a raw value for inclusion in an error message. For keys that
 * look sensitive, the value is replaced with a placeholder so errors remain
 * diagnosable without exposing secrets.
 *
 * @param key - Environment variable name
 * @param raw - Raw value read from the environment
 * @returns A display-safe string
 */
function describeRaw(key: string, raw: string): string {
  if (isSensitiveKey(key)) {
    return '<redacted>';
  }
  return `"${raw}"`;
}

/**
 * Reads a raw environment variable, treating empty or whitespace-only
 * strings as undefined.
 *
 * @param key - Environment variable name
 * @param env - Optional source; existing callers continue to use process.env
 * @returns The trimmed value, or undefined if missing/empty
 */
export function getEnv(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

/**
 * Reads a required environment variable. Throws a descriptive error if
 * the variable is missing or empty.
 *
 * @param key - Environment variable name
 * @returns The trimmed value
 * @throws {Error} If the variable is missing or empty
 */
export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        'Set it in your environment or .env file.',
    );
  }
  return value;
}

/**
 * Reads an optional environment variable, returning a default value if
 * the variable is missing or empty.
 *
 * @param key - Environment variable name
 * @param defaultValue - Value to return if the variable is not set
 * @returns The trimmed value or the default
 */
export function optionalEnv(key: string, defaultValue: string): string {
  return getEnv(key) ?? defaultValue;
}

/**
 * Parses an environment variable as an integer. Returns a default value
 * if the variable is missing. Throws if the value is not a valid integer.
 *
 * @param key - Environment variable name
 * @param defaultValue - Value to return if the variable is not set
 * @returns The parsed integer value
 * @throws {Error} If the value cannot be parsed as an integer
 */
export function parseIntEnv(key: string, defaultValue: number): number {
  const raw = getEnv(key);
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.finite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `Environment variable ${key} must be a valid integer, got: ${describeRaw(key, raw)}",
    );
  }
  return parsed;
}

/**
 * Parses an environment variable as a boolean. Accepts "true"/"1" and
 * "false"/"0" (case-insensitive). Returns a default value if the variable
 * is missing. Throws if the value is not a recognized boolean string.
 *
 * @param key - Environment variable name
 * @param defaultValue - Value to return if the variable is not set
 * @param env - Optional source; defaults to process.env for existing callers
 * @returns The parsed boolean value
 * @throws {Error} If the value is not a recognized boolean string
 */
export function parseBoolEnv(
  key: string,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = getEnv(key, env);
  if (raw === undefined) {
    return defaultValue;
  }
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === '1') {
    return true;
  }
  if (lower === 'false' || lower === '0') {
    return false;
  }
  throw new Error(
    `Environment variable ${key} must be "true" or "false", got: ${describeRaw(key, raw)}`,
  );
}
