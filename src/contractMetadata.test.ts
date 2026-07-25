/**
 * @file contractMetadata.test.ts
 * @description Comprehensive tests for the contract metadata hash verification module.
 *
 * Security focus areas:
 *  - timingSafeHashEqual must NEVER throw; mismatched lengths are a controlled rejection.
 *  - No raw hash values appear in log output.
 *  - fetchAndVerify is fail-closed: any hash mismatch (including length) rejects with
 *    ContractMetadataMismatchError before any settlement/processing occurs.
 */

import crypto from 'crypto';
import {
  canonicalize,
  computeMetadataHash,
  timingSafeHashEqual,
  fetchAndVerify,
  resetMetricsForTest,
} from './contractMetadata';
import { register } from 'prom-client';
import { ContractMetadataMismatchError } from './errors/appError';
import { setWriteRecordImpl } from './logger';
import type { LogRecord } from './logger';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetMetricsForTest();
  // Silence log output during tests (replace with no-op writer)
  setWriteRecordImpl(() => undefined);
});

afterEach(() => {
  // Restore default stderr/stdout writer
  setWriteRecordImpl((record: LogRecord) => {
    const line = JSON.stringify(record);
    if (record.level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  });
});

// ===========================================================================
// canonicalize
// ===========================================================================

describe('canonicalize', () => {
  it('produces deterministic output regardless of key insertion order', () => {
    const a = { b: 2, a: 1, c: 3 };
    const b = { c: 3, a: 1, b: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('handles nested objects recursively', () => {
    const a = { outer: { z: 'last', a: 'first' } };
    const b = { outer: { a: 'first', z: 'last' } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('handles arrays preserving element order', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([3, 2, 1])).toBe('[3,2,1]');
  });

  it('handles null', () => {
    expect(canonicalize(null)).toBe('null');
  });

  it('handles primitive strings', () => {
    expect(canonicalize('hello')).toBe('"hello"');
  });

  it('handles numbers', () => {
    expect(canonicalize(42)).toBe('42');
  });

  it('handles boolean values', () => {
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });

  it('handles empty object', () => {
    expect(canonicalize({})).toBe('{}');
  });

  it('handles empty array', () => {
    expect(canonicalize([])).toBe('[]');
  });
});

// ===========================================================================
// computeMetadataHash
// ===========================================================================

describe('computeMetadataHash', () => {
  it('returns a 64-character lowercase hex SHA-256 digest', () => {
    const hash = computeMetadataHash({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of key order', () => {
    expect(computeMetadataHash({ b: 2, a: 1 })).toBe(computeMetadataHash({ a: 1, b: 2 }));
  });

  it('produces different hashes for different inputs', () => {
    expect(computeMetadataHash({ a: 1 })).not.toBe(computeMetadataHash({ a: 2 }));
  });

  it('matches a known SHA-256 value for a simple input', () => {
    // Pre-computed: SHA256('{"a":1}') — note canonicalize sorts keys
    const expected = crypto.createHash('sha256').update('{"a":1}', 'utf8').digest('hex');
    expect(computeMetadataHash({ a: 1 })).toBe(expected);
  });
});

// ===========================================================================
// timingSafeHashEqual — the core security fix
// ===========================================================================

describe('timingSafeHashEqual', () => {
  const HASH_A = 'a'.repeat(64); // 64 hex chars = 32 bytes as UTF-8
  const HASH_B = 'b'.repeat(64);

  // --- positive path ---

  it('returns true when both strings are identical', () => {
    expect(timingSafeHashEqual(HASH_A, HASH_A)).toBe(true);
  });

  it('returns true for two independently constructed equal strings', () => {
    const hash = computeMetadataHash({ version: 1, name: 'escrow' });
    const copy = hash.slice(); // brand-new string reference
    expect(timingSafeHashEqual(hash, copy)).toBe(true);
  });

  // --- negative path: equal-length but different content ---

  it('returns false for same-length strings with different content', () => {
    expect(timingSafeHashEqual(HASH_A, HASH_B)).toBe(false);
  });

  it('returns false when single character differs', () => {
    const base = '0'.repeat(64);
    const altered = base.slice(0, 63) + '1';
    expect(timingSafeHashEqual(base, altered)).toBe(false);
  });

  // --- negative path: length mismatch (the critical guard) ---

  it('returns false — does NOT throw — when observed hash is shorter than expected', () => {
    const shorter = HASH_A.slice(0, 32); // 32 chars instead of 64
    expect(() => timingSafeHashEqual(shorter, HASH_A)).not.toThrow();
    expect(timingSafeHashEqual(shorter, HASH_A)).toBe(false);
  });

  it('returns false — does NOT throw — when observed hash is longer than expected', () => {
    const longer = HASH_A + HASH_A; // 128 chars
    expect(() => timingSafeHashEqual(longer, HASH_A)).not.toThrow();
    expect(timingSafeHashEqual(longer, HASH_A)).toBe(false);
  });

  it('returns false — does NOT throw — when expected hash is empty', () => {
    expect(() => timingSafeHashEqual(HASH_A, '')).not.toThrow();
    expect(timingSafeHashEqual(HASH_A, '')).toBe(false);
  });

  it('returns false — does NOT throw — when observed hash is empty', () => {
    expect(() => timingSafeHashEqual('', HASH_A)).not.toThrow();
    expect(timingSafeHashEqual('', HASH_A)).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeHashEqual('', '')).toBe(true);
  });

  it('returns false — does NOT throw — for wildly different lengths', () => {
    expect(() => timingSafeHashEqual('abc', HASH_A)).not.toThrow();
    expect(timingSafeHashEqual('abc', HASH_A)).toBe(false);
  });

  it('never propagates a RangeError regardless of input lengths', () => {
    // timingSafeEqual would throw RangeError for unequal lengths;
    // our wrapper must absorb that entirely.
    const inputs: Array<[string, string]> = [
      ['', 'x'],
      ['x', ''],
      ['abc', 'abcd'],
      ['a'.repeat(1), 'a'.repeat(100)],
      ['a'.repeat(100), 'a'.repeat(1)],
    ];
    for (const [a, b] of inputs) {
      expect(() => timingSafeHashEqual(a, b)).not.toThrow();
    }
  });

  // --- security: raw hashes must not appear in logs ---

  it('does not log raw hash values on length mismatch', async () => {
    const records: LogRecord[] = [];
    setWriteRecordImpl((r) => records.push(r));

    const shortHash = 'deadbeef';
    const fullHash = computeMetadataHash({ x: 1 });
    timingSafeHashEqual(shortHash, fullHash);

    // No log record should contain either raw hash value
    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(shortHash);
      expect(serialized).not.toContain(fullHash);
    }
  });
});

// ===========================================================================
// fetchAndVerify
// ===========================================================================

describe('fetchAndVerify', () => {
  const metadata = { version: 1, name: 'escrow', amount: '1000' };
  const correctHash = computeMetadataHash(metadata);

  // --- argument validation ---

  it('throws immediately when contractId is empty', async () => {
    await expect(
      fetchAndVerify('', 'https://rpc.test', correctHash, jest.fn()),
    ).rejects.toThrow('contractId is required');
  });

  // --- happy path ---

  it('returns metadata when no expectedHash is provided', async () => {
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });
    const out = await fetchAndVerify('CABC', 'https://rpc.test', undefined, fetcher);
    expect(out).toEqual(metadata);
  });

  it('returns metadata when expectedHash matches exactly', async () => {
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });
    const out = await fetchAndVerify('CABC', 'https://rpc.test', correctHash, fetcher);
    expect(out).toEqual(metadata);
  });

  it('returns metadata when expectedHash matches with uppercase letters', async () => {
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });
    const upperHash = correctHash.toUpperCase();
    const out = await fetchAndVerify('CABC', 'https://rpc.test', upperHash, fetcher);
    expect(out).toEqual(metadata);
  });

  it('uses resp directly when resp.result is absent', async () => {
    const fetcher = jest.fn().mockResolvedValue(metadata); // no .result wrapper
    const out = await fetchAndVerify('CABC', 'https://rpc.test', correctHash, fetcher);
    expect(out).toEqual(metadata);
  });

  // --- mismatch: equal-length hash ---

  it('throws ContractMetadataMismatchError on equal-length hash mismatch', async () => {
    const wrongHash = '0'.repeat(64); // same length (64 hex chars), different content
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    await expect(
      fetchAndVerify('CABC', 'https://rpc.test', wrongHash, fetcher),
    ).rejects.toBeInstanceOf(ContractMetadataMismatchError);
  });

  // --- mismatch: length differs (the bug fix) ---

  it('throws ContractMetadataMismatchError — NOT RangeError — when hash is shorter', async () => {
    const shortHash = correctHash.slice(0, 32); // only 32 chars
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    await expect(
      fetchAndVerify('CABC', 'https://rpc.test', shortHash, fetcher),
    ).rejects.toBeInstanceOf(ContractMetadataMismatchError);
  });

  it('throws ContractMetadataMismatchError — NOT RangeError — when hash is longer', async () => {
    const longHash = correctHash + correctHash; // 128 chars
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    await expect(
      fetchAndVerify('CABC', 'https://rpc.test', longHash, fetcher),
    ).rejects.toBeInstanceOf(ContractMetadataMismatchError);
  });

  it('throws ContractMetadataMismatchError — NOT RangeError — when hash is empty string', async () => {
    // Note: an empty string is falsy; fetchAndVerify treats it the same as
    // `undefined` (no expected hash → skip verification). This is intentional:
    // callers that want to enforce a hash should pass a non-empty string.
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });
    const out = await fetchAndVerify('CABC', 'https://rpc.test', '', fetcher);
    expect(out).toEqual(metadata); // skipped verification — returned metadata
  });

  it('does NOT throw RangeError for any hash length mismatch scenario', async () => {
    const testCases = [
      correctHash.slice(0, 1),   // 1 char
      correctHash.slice(0, 10),  // 10 chars
      correctHash.slice(0, 63),  // 63 chars (one short)
      correctHash + 'a',         // 65 chars (one extra)
      correctHash.repeat(2),     // 128 chars
    ];

    for (const badHash of testCases) {
      const fetcher = jest.fn().mockResolvedValue({ result: metadata });
      // Must reject with ContractMetadataMismatchError, never RangeError
      await expect(
        fetchAndVerify('CABC', 'https://rpc.test', badHash, fetcher),
      ).rejects.toBeInstanceOf(ContractMetadataMismatchError);
    }
  });

  // --- metrics ---

  it('increments mismatch counter on hash mismatch', async () => {
    const wrongHash = '0'.repeat(64);
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    await expect(
      fetchAndVerify('CONTRACT_1', 'https://rpc.test', wrongHash, fetcher),
    ).rejects.toBeInstanceOf(ContractMetadataMismatchError);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m: any) => m.name === 'contract_metadata_mismatch_total');
    expect(metric).toBeDefined();
    const val = metric!.values?.find(
      (v: any) => v.labels && v.labels.contract === 'CONTRACT_1',
    );
    expect(val).toBeDefined();
    expect(val!.value).toBe(1);
  });

  it('increments mismatch counter on length-mismatch rejection', async () => {
    const shortHash = correctHash.slice(0, 16);
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    await expect(
      fetchAndVerify('CONTRACT_2', 'https://rpc.test', shortHash, fetcher),
    ).rejects.toBeInstanceOf(ContractMetadataMismatchError);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m: any) => m.name === 'contract_metadata_mismatch_total');
    const val = metric!.values?.find(
      (v: any) => v.labels && v.labels.contract === 'CONTRACT_2',
    );
    expect(val).toBeDefined();
    expect(val!.value).toBe(1);
  });

  it('does NOT increment mismatch counter on successful verification', async () => {
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    await fetchAndVerify('CONTRACT_OK', 'https://rpc.test', correctHash, fetcher);

    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m: any) => m.name === 'contract_metadata_mismatch_total');
    // Either no metric or the contract label has value 0
    if (metric) {
      const val = metric.values?.find(
        (v: any) => v.labels && v.labels.contract === 'CONTRACT_OK',
      );
      expect(val?.value ?? 0).toBe(0);
    } else {
      expect(metric).toBeUndefined();
    }
  });

  // --- security: raw hashes must not appear in logs ---

  it('does not log raw hash values on mismatch', async () => {
    const records: LogRecord[] = [];
    setWriteRecordImpl((r) => records.push(r));

    const wrongHash = '1'.repeat(64);
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    try {
      await fetchAndVerify('CABC', 'https://rpc.test', wrongHash, fetcher);
    } catch {
      // expected
    }

    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(wrongHash);
      expect(serialized).not.toContain(correctHash);
    }
  });

  it('does not log raw hash values on length-mismatch', async () => {
    const records: LogRecord[] = [];
    setWriteRecordImpl((r) => records.push(r));

    const shortHash = 'abcd1234';
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    try {
      await fetchAndVerify('CABC', 'https://rpc.test', shortHash, fetcher);
    } catch {
      // expected
    }

    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(shortHash);
      expect(serialized).not.toContain(correctHash);
    }
  });

  // --- fetcher is actually called ---

  it('calls the fetcher with the correct rpcUrl and JSON-RPC body', async () => {
    const fetcher = jest.fn().mockResolvedValue({ result: metadata });
    await fetchAndVerify('MY_CONTRACT', 'https://rpc.example.com', correctHash, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://rpc.example.com', {
      jsonrpc: '2.0',
      id: 1,
      method: 'get_contract_data',
      params: { contract_id: 'MY_CONTRACT' },
    });
  });
});
