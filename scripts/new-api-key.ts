/**
 * @module scripts/new-api-key
 * @description Generate a new scoped API key and print the JSON entry to
 * paste into the API_KEYS environment variable.
 *
 * Usage:
 *   npx ts-node scripts/new-api-key.ts <id> <scope1> [scope2] ...
 *
 * Example:
 *   npx ts-node scripts/new-api-key.ts ops-1 disputes:resolve admin:read
 *
 * Output:
 *   Line 1: the plaintext key (tt__<32+ random base62 chars>) — shown ONCE
 *   Line 2+: the JSON entry to paste into API_KEYS
 */

import * as crypto from 'crypto';
import { VALID_SCOPES } from '../src/auth/scopes';

const BASE62_CHARS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generate a random base62 string of the given length.
 */
function randomBase62(length: number): string {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62_CHARS[bytes[i] % 62];
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

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      'Usage: npx ts-node scripts/new-api-key.ts <id> <scope1> [scope2] ...',
    );
    console.error(`Valid scopes: ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }

  const id = args[0];
  const scopes = args.slice(1);

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
  const entry = { id, hash, scopes };
  console.log(JSON.stringify(entry, null, 2));
}

main();
