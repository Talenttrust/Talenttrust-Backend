/**
 * @module utils/deduplication
 * @description
 *   Deterministic event deduplication and payload-integrity helpers.
 *
 *   All methods on {@link DeduplicationManager} are **pure, static, and
 *   stateless** — the manager owns no in-memory store, no cache, no
 *   timer. Idempotency windowing and eviction live in
 *   `src/events/idempotency.ts`, separately tested. Anything you see here
 *   is a) deterministic for the same input and b) safe for concurrent
 *   callers with no shared mutable state.
 *
 *   ## Security model
 *
 *   The two security-sensitive surfaces are:
 *
 *     1. **Canonical hashing** — `computePayloadHash` reduces JSON-ish
 *        payloads to a stable SHA-256 digest via a canonicalization step
 *        that sorts object keys recursively. Without canonicalization,
 *        `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` would hash differently,
 *        breaking downstream dedupe across services whose JSON encoders
 *        differ.
 *
 *     2. **Constant-time comparison** — `comparePayloadHashes` uses
 *        `crypto.timingSafeEqual` so the comparison's wall-time does not
 *        leak the position of the first differing byte. Before calling
 *        `timingSafeEqual` (which throws on mismatched-length buffers
 *        via `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`) the function checks
 *        lengths and, when they differ, performs a *self-comparison*
 *        (`timingSafeEqual(actual, actual)`) so the time taken looks
 *        identical to the equal-length / not-equal case. This means an
 *        attacker cannot infer whether their hash guess has the right
 *        length by timing alone.
 *
 *   ## Why no TTL/eviction here
 *
 *   "Dedup" here is the *key derivation* layer, not the *storage*
 *   layer. The manager returns keys/hashes/comparisons; the retention
 *   policy lives in `src/events/idempotency.ts`. Tests for eviction
 *   belong there, not here.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { ContractEvent, JsonValue } from '../events/types';

/**
 * Static utility class — see module-level docs for the security model
 * and the rationale for the no-TTL design.
 */
export class DeduplicationManager {
  /**
   * Derives the stable deduplication key for a contract event.
   *
   * Format is `contractId:eventId:sequence`. Deliberately does NOT
   * include the payload — payload bytes are checked separately via
   * {@link validatePayloadIntegrity} so a payload mutation does not
   * change the dedup key (it changes the integrity verdict instead).
   *
   * @param event - The contract event.
   * @returns Stable string key, byte-stable for same inputs.
   */
  static computeDeduplicationKey(event: ContractEvent): string {
    const keyComponents = [
      event.contractId,
      event.eventId,
      event.sequence.toString()
    ];

    return keyComponents.join(':');
  }

  /**
   * Computes a SHA-256 digest of a payload after JSON canonicalization.
   *
   * Canonicalization sorts object keys at every nesting level so
   * independent encoders produce identical digests. Without this,
   * `{a:1,b:2}` and `{b:2,a:1}` would produce different integrity
   * verdicts depending on the producer's iteration order — a real
   * cross-service bug surface for event ingestion.
   *
   * @param payload - Any JSON-serializable value.
   * @returns 64-char lowercase hex SHA-256 digest.
   */
  static computePayloadHash(payload: JsonValue): string {
    return createHash('sha256').update(canonicalize(payload)).digest('hex');
  }

  /**
   * Verifies that an event's payload matches the previously-recorded
   * integrity hash.
   *
   * Goes through `computePayloadHash` (canonicalized) and then
   * {@link comparePayloadHashes} (timing-safe). Never throws — a
   * malformed `expectedHash` simply returns `false`.
   *
   * @param event - The contract event under test.
   * @param expectedHash - The previously-recorded hex SHA-256 digest.
   * @returns `true` iff the recomputed hash equals `expectedHash`.
   */
  static validatePayloadIntegrity(event: ContractEvent, expectedHash: string): boolean {
    const actualHash = this.computePayloadHash(event.payload);
    return this.comparePayloadHashes(actualHash, expectedHash);
  }

  /**
   * Constant-time comparison of two payload hashes.
   *
   * When buffer lengths match we delegate to `crypto.timingSafeEqual`,
   * whose runtime is independent of *where* the buffers differ. When
   * lengths differ we MUST NOT pass mismatched buffers to
   * `timingSafeEqual` (it throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`)
   * — instead we perform a self-comparison
   * (`timingSafeEqual(actual, actual)`) so the wall-clock cost of a
   * length-mismatch reject looks the same as a same-length mismatch.
   * This closes the length-based timing side-channel.
   *
   * SECURITY invariant tested in `src/utils/deduplication.test.ts`:
   * `timingSafeEqual` is never called with two buffers of different
   * lengths.
   *
   * @param actualHash - The hash computed from the received payload.
   * @param expectedHash - The hash stored for the idempotency key.
   * @returns `true` when both hashes are identical SHA-256 digests.
   */
  static comparePayloadHashes(actualHash: string, expectedHash: string): boolean {
    const actualBuffer = Buffer.from(actualHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');

    if (actualBuffer.length !== expectedBuffer.length) {
      timingSafeEqual(actualBuffer, actualBuffer);
      return false;
    }

    return timingSafeEqual(actualBuffer, expectedBuffer);
  }

  /**
   * Inverse of {@link computeDeduplicationKey}. Splits on the first two
   * `:` separators; the third segment is `parseInt`'d.
   *
   * Note: a non-numeric sequence segment yields `NaN` — `parseInt`'s
   * documented behaviour. The dedup layer never *writes* such keys;
   * this method is intended for trusted internal callers.
   *
   * @param deduplicationKey - Key previously produced by {@link computeDeduplicationKey}.
   * @returns The `contractId`, `eventId`, and numeric `sequence`.
   */
  static parseDeduplicationKey(deduplicationKey: string): {
    contractId: string;
    eventId: string;
    sequence: number;
  } {
    const [contractId, eventId, sequenceStr] = deduplicationKey.split(':');

    return {
      contractId,
      eventId,
      sequence: parseInt(sequenceStr, 10)
    };
  }

  /**
   * Checks if two events represent the same logical event by comparing
   * their dedup keys. Payload bytes are deliberately ignored here —
   * equivalence of *identity* is what dedupe gates; integrity of
   * *contents* is checked separately via {@link validatePayloadIntegrity}.
   *
   * @param event1 - First event.
   * @param event2 - Second event.
   * @returns `true` iff both events share the same `contractId:eventId:sequence`.
   */
  static areEventsDuplicates(event1: ContractEvent, event2: ContractEvent): boolean {
    return this.computeDeduplicationKey(event1) === this.computeDeduplicationKey(event2);
  }
}

/**
 * Recursive JSON-canonicalization. Sorts object keys at every level
 * so the digest is order-insensitive. The output is NOT valid JSON in
 * the multi-line sense, but `JSON.parse` will round-trip it cleanly.
 * Kept module-private because the format is tied to the digest and
 * should not be parsed by callers.
 */
function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(',')}}`;
}
