/**
 * Integer base-unit amount validation and arithmetic helpers.
 *
 * Amounts are integers in the token's smallest unit (stroops for XLM, 7 decimals).
 * This mirrors the Soroban contract's i128 checked arithmetic so the API and the
 * contract always agree on every value.
 */

import { HttpError } from './amount-error';

/** i128 maximum: 2^127 - 1 */
export const I128_MAX = (2n ** 127n) - 1n;

/**
 * Strict integer amount parser.
 *
 * Accepts:
 *   - A JSON integer that is a safe integer (no fractions, no exponent notation
 *     once parsed, within Number.MAX_SAFE_INTEGER).
 *   - A decimal string matching ^[1-9][0-9]{0,37}$ (positive, no leading zeros,
 *     at most 38 digits — enough for i128 max).
 *
 * Rejects everything else with HTTP 400 `invalid_amount`:
 *   booleans, arrays, objects, floats, exponent strings ("1e2"), whitespace,
 *   negatives, zero, null, undefined.
 *
 * @param raw   The raw value from the request body.
 * @param field A human-readable field name used in the error message.
 */
export function parseAmount(raw: unknown, field: string): bigint {
  // Reject booleans explicitly (typeof boolean === 'boolean', but Number(true) === 1)
  if (typeof raw === 'boolean') {
    throw new HttpError(400, 'invalid_amount', `${field} must be a positive integer (got boolean)`);
  }

  // Reject arrays and objects
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_amount', `${field} must be a positive integer`);
  }

  if (typeof raw === 'number') {
    // Reject NaN, Infinity, fractions, and values outside safe-integer range
    if (
      !Number.isFinite(raw) ||
      !Number.isInteger(raw) ||
      !Number.isSafeInteger(raw) ||
      raw <= 0
    ) {
      throw new HttpError(
        400,
        'invalid_amount',
        `${field} must be a positive safe integer (no fractions, no exponent overflow)`,
      );
    }
    return BigInt(raw);
  }

  // String path: accept only ^[1-9][0-9]{0,38}$ — positive, no leading zeros,
  // no whitespace, no sign, no decimal point, no exponent notation.
  // Allows up to 39 digits (sufficient for i128 max = 170141183460469231731687303715884105727).
  if (!/^[1-9][0-9]{0,38}$/.test(raw)) {
    throw new HttpError(
      400,
      'invalid_amount',
      `${field} string must match ^[1-9][0-9]{0,38}$ (positive decimal integer, no leading zeros)`,
    );
  }

  return BigInt(raw);
}

/**
 * Add two bigint amounts and return the result, throwing HTTP 400 if the result
 * would exceed I128_MAX. Mirrors the contract's checked_add.
 */
export function checkedAdd(a: bigint, b: bigint, field: string): bigint {
  const result = a + b;
  if (result > I128_MAX) {
    throw new HttpError(
      400,
      'invalid_amount',
      `${field} addition overflows i128 max (2^127 - 1)`,
    );
  }
  return result;
}

/**
 * BigInt-safe JSON replacer. Serialises bigint values as decimal strings so that
 * JSON.stringify never throws on a response containing bigint amounts.
 *
 * Usage: JSON.stringify(value, bigIntReplacer)
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}
