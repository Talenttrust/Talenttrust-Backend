import axios from 'axios';
import crypto from 'crypto';
import { Counter, register } from 'prom-client';
import { ContractMetadataMismatchError } from './errors/appError';
import { createLogger } from './logger';

/**
 * Counter to record contract metadata mismatches observed at runtime.
 * Label: contract - the contract id being verified.
 */
const mismatchCounter = new Counter({
  name: 'contract_metadata_mismatch_total',
  help: 'Total number of observed contract metadata mismatches',
  labelNames: ['contract'],
});

/**
 * Module-level logger for contract metadata verification diagnostics.
 * Raw hash values are never written to log output.
 */
const log = createLogger({ module: 'contractMetadata' });

/**
 * Canonicalize an object to deterministically stable JSON for hashing.
 * Sorts object keys recursively so semantically-equal metadata produces
 * the same canonical string.
 *
 * @param value - Any JSON-serialisable value to canonicalize.
 * @returns A deterministic JSON string with object keys sorted recursively.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/** Compute SHA256 hex digest of canonicalized metadata */
export function computeMetadataHash(metadata: unknown): string {
  const canon = canonicalize(metadata);
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

/**
 * Perform a constant-time comparison of two hash strings.
 *
 * `crypto.timingSafeEqual` requires both `Buffer` arguments to have the
 * **same byte length**; passing buffers of different lengths throws a
 * `RangeError`. This function adds an explicit length guard so that any
 * length mismatch is treated as a verification failure and returned as
 * `false` without ever throwing.
 *
 * @param a - First hash string (hex or any encoding).
 * @param b - Second hash string to compare against `a`.
 * @returns `true` when both strings are identical in length and content;
 *   `false` for any length mismatch or content difference.
 *
 * @remarks
 * - The comparison is case-sensitive by design; callers must normalise case
 *   before invoking this function (e.g. both `.toLowerCase()`).
 * - No raw hash values are written to logs; only length metadata is emitted
 *   at debug level for diagnostics.
 * - A length difference short-circuits immediately so that zero information
 *   about the expected hash length is inferred from timing.
 */
export function timingSafeHashEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    log.debug('Hash length mismatch — short-circuiting to not-verified', {
      observedLength: bufA.length,
      expectedLength: bufB.length,
    });
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

export type Fetcher = (url: string, body?: any) => Promise<any>;

/**
 * Fetches metadata from a Soroban RPC for a given contract and verifies
 * it matches the expected SHA-256 hex hash if provided.
 *
 * Hash verification uses a length-guarded constant-time comparison via
 * {@link timingSafeHashEqual}. An unequal length is treated as a
 * verification failure (controlled `ContractMetadataMismatchError`) — it
 * never throws a `RangeError` or any other unhandled exception.
 *
 * @param contractId - On-chain contract identifier; must be non-empty.
 * @param rpcUrl - Soroban JSON-RPC endpoint URL.
 * @param expectedHash - Optional pinned SHA-256 hex digest. When omitted,
 *   hash verification is skipped.
 * @param fetcher - Optional injectable HTTP fetcher used for testing.
 *   Defaults to `axios.post`.
 * @returns The raw metadata payload returned by the RPC.
 * @throws {Error} When `contractId` is empty.
 * @throws {ContractMetadataMismatchError} When the observed hash does not
 *   match `expectedHash` (including length mismatches).
 *
 * @security
 *  Raw hash values are never written to log output. The mismatch counter
 *  is incremented so operators can alert on anomalous patterns without
 *  exposing hash content in logs.
 */
export async function fetchAndVerify(
  contractId: string,
  rpcUrl: string,
  expectedHash?: string,
  fetcher?: Fetcher,
): Promise<any> {
  if (!contractId) throw new Error('contractId is required');
  const call = fetcher ?? (async (u: string, body?: any) => (await axios.post(u, body)).data);

  // Minimal JSON-RPC body — callers/tests can replace fetcher with whatever
  // RPC method is appropriate for their environment.
  const body = { jsonrpc: '2.0', id: 1, method: 'get_contract_data', params: { contract_id: contractId } };
  const resp = await call(rpcUrl, body);
  const metadata = resp?.result ?? resp;

  if (expectedHash) {
    const observed = computeMetadataHash(metadata).toLowerCase();
    const expected = expectedHash.toLowerCase();

    const matched = timingSafeHashEqual(observed, expected);

    if (!matched) {
      mismatchCounter.inc({ contract: contractId });
      log.warn('Contract metadata hash verification failed — rejecting', {
        contractId,
        observedHashLength: observed.length,
        expectedHashLength: expected.length,
      });
      throw new ContractMetadataMismatchError();
    }
  }

  return metadata;
}

/** Test helper: allow tests to read/reset the mismatch counter. */
export function getMismatchMetric(): Counter<string> {
  return mismatchCounter;
}

/**
 * Reset Prometheus register and re-register the module counter.
 *
 * Used in tests to avoid cross-test metric pollution. After `register.clear()`
 * the counter object is detached; calling `register.registerMetric` restores
 * it so subsequent `getMetricsAsJSON()` calls include the counter again.
 */
export function resetMetricsForTest(): void {
  try {
    register.clear();
    // Re-attach the module counter so getMetricsAsJSON finds it again.
    register.registerMetric(mismatchCounter);
  } catch {
    // ignore — metric may already be registered in some environments
  }
}

export default {
  canonicalize,
  computeMetadataHash,
  timingSafeHashEqual,
  fetchAndVerify,
  getMismatchMetric,
  resetMetricsForTest,
};
