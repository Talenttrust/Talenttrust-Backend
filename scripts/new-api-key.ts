/**
 * @module scripts/new-api-key
 * @description Generate a new scoped API key and print the JSON entry to
 * paste into the API_KEYS environment variable.
 *
 * Usage:
 *   npx ts-node scripts/new-api-key.ts [--expires-in-days <n>] <id> <scope1> [scope2] ...
 *
 * Example:
 *   npx ts-node scripts/new-api-key.ts ops-1 disputes:resolve admin:read
 *   npx ts-node scripts/new-api-key.ts --expires-in-days 30 contractor-1 admin:read
 *
 * `--expires-in-days <n>` (a positive whole number, also `--expires-in-days=<n>`)
 * adds `expiresAt` to the entry, n days from now in UTC.
 *
 * Output:
 *   Line 1: the plaintext key (tt__<32+ random base62 chars>) — shown ONCE
 *   Line 2+: the JSON entry to paste into API_KEYS
 */

import * as crypto from 'crypto';
import { VALID_SCOPES } from '../src/auth/scopes';

export const BASE62_CHARS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generate a random base62 string of the given length without modulo bias.
 */
export function randomBase62(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62_CHARS[crypto.randomInt(0, 62)];
  }
  return result;
}

/**
 * Generate a new API key with the `tt__` prefix and 32 random base62 characters.
 */
export function generateNewApiKey(): string {
  return `tt__${randomBase32()}`;
}

/**
 * Generate 32 random base62 characters.
 */
function randomBase32(): string {
  return randomBase62(32);
}

/**
 * SHA-256 hash a plaintext key and return the `sha256:<hex>` format string.
 */
export function hashApiKey(plaintext: string): string {
  const digest = crypto.createHash('sha256').update(plaintext).digest('hex');
  return `sha256:${digest}`;
}

const USAGE =
  'Usage: npx ts-node scripts/new-api-key.ts [--expires-in-days <n>] <id> <scope1> [scope2] ...';

/** Parsed command line of the script. */
export interface NewApiKeyArgs {
  id: string;
  scopes: string[];
  /** Whole days until expiry, when `--expires-in-days` was given. */
  expiresInDays?: number;
}

/**
 * Parse the script's arguments. Throws with a usage message on a missing id
 * or scope, or an `--expires-in-days` value that is not a positive whole number.
 */
export function parseNewApiKeyArgs(argv: string[]): NewApiKeyArgs {
  const positional: string[] = [];
  let expiresInDays: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let raw: string | undefined;
    if (arg === '--expires-in-days') {
      raw = argv[++i];
    } else if (arg.startsWith('--expires-in-days=')) {
      raw = arg.slice('--expires-in-days='.length);
    } else {
      positional.push(arg);
      continue;
    }
    if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error('--expires-in-days must be a positive whole number of days');
    }
    expiresInDays = Number(raw);
  }
  if (positional.length < 2) throw new Error(USAGE);
  return { id: positional[0], scopes: positional.slice(1), expiresInDays };
}

/** ISO 8601 UTC instant `days` whole days after `nowMs`. */
export function expiresAtFromDays(days: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
}

function main(): void {
  let parsed: NewApiKeyArgs;
  try {
    parsed = parseNewApiKeyArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    if (!(err instanceof Error) || err.message !== USAGE) console.error(USAGE);
    console.error(`Valid scopes: ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }

  const { id, scopes, expiresInDays } = parsed;

  // Validate scopes
  for (const scope of scopes) {
    if (!VALID_SCOPES.includes(scope)) {
      console.error(
        `Unknown scope: "${scope}". Valid scopes: ${VALID_SCOPES.join(', ')}`,
      );
      process.exit(1);
    }
  }

  const plaintextKey = generateNewApiKey();
  const hash = hashApiKey(plaintextKey);

  // Print the plaintext key ONCE
  console.log(plaintextKey);

  // Print the JSON entry
  const entry: { id: string; hash: string; scopes: string[]; expiresAt?: string } = { id, hash, scopes };
  if (expiresInDays !== undefined) entry.expiresAt = expiresAtFromDays(expiresInDays);
  console.log(JSON.stringify(entry, null, 2));
}

if (require.main === module) main();
