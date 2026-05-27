/**
 * Environment variable parsing and validation utilities.
 *
 * These functions provide type-safe access to environment variables with
 * validation, default values, and descriptive error messages on failure.
 * Empty strings are treated as missing values.
 * @module
 */

/**
 * Reads a raw environment variable, treating empty or whitespace-only
 * strings as undefined.
 *
 * @param key - Environment variable name
 * @returns The trimmed value, or undefined if missing/empty
 */
export function getEnv(key: string): string | undefined {
  const value = process.env[key];
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
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `Environment variable ${key} must be a valid integer, got: "${raw}"`,
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
 * @returns The parsed boolean value
 * @throws {Error} If the value is not a recognized boolean string
 */
export function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const raw = getEnv(key);
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
    `Environment variable ${key} must be "true" or "false", got: "${raw}"`,
  );
}
