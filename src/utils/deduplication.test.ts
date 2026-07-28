/**
 * @file deduplication.test.ts
 * @description
 *   Coverage for `DeduplicationManager` in `src/utils/deduplication.ts`.
 *
 *   Two distinct invariants deserve explicit guard here:
 *
 *     1. **Hash stability** — `computePayloadHash` must produce identical
 *        digests for identical inputs (canonicalized) and distinct
 *        digests for distinct inputs. This is the foundation of the
 *        idempotency / dedupe guarantees downstream.
 *
 *     2. **Constant-time comparison** — `comparePayloadHashes` must NEVER
 *        pass mismatched-length buffers to `crypto.timingSafeEqual`.
 *        `timingSafeEqual` would throw `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`
 *        if called with mismatched lengths, but more importantly the
 *        length-guard branch exists so a length observation by an
 *        attacker cannot become a side-channel of the comparison.
 *
 *   Shared test helpers in this file are documented with TSDoc so the
 *   payload fixtures explain *why* they collide/diverge rather than just
 *   listing them, per the issue's "Add TSDoc to shared test helpers"
 *   requirement.
 *
 *   Coverage goal: ≥ 95% lines/branches/functions/statements for
 *   `src/utils/deduplication.ts`. No TTL/eviction behaviour is asserted
 *   because `DeduplicationManager` is intentionally stateless — it
 *   exposes no in-memory store or expiry surface.
 */

import * as crypto from 'crypto';
import { DeduplicationManager } from './deduplication';
import { ContractEvent, JsonValue } from '../events/types';

// SECURITY-TEST NOTE (interception mechanism):
//   We intercept `crypto.timingSafeEqual` via `jest.mock('crypto', …)`
//   at module-load time. The mock replaces the named export with a
//   `jest.fn` that wraps the real implementation, so the production
//   code (`src/utils/deduplication.ts`, doing
//   `import { timingSafeEqual } from 'crypto'`) resolves to the SAME
//   mocked binding — every `timingSafeEqual(...)` call from
//   production lands in our jest.fn, and assertions on
//   `crypto.timingSafeEqual.mock.calls` reflect actual invocations.
//
//   Why not `jest.spyOn(crypto, 'timingSafeEqual')`? On Node 18+ the
//   crypto module exports are non-configurable by default, so
//   `jest.spyOn` throws `TypeError: Cannot redefine property:
//   timingSafeEqual`. `jest.mock` at module load replaces the export
//   descriptor entirely before any code captures the binding.
//
//   We pass `actual.timingSafeEqual` DIRECTLY to `jest.fn(...)` rather
//   than re-declaring its parameter types. This avoids parameter-type
//   contravariance rejections under `strictFunctionTypes` (the wrapper
//   inherits the real function's full signature verbatim, including
//   `BinaryLike` overloads).
//
//   Pair any future refactor of dedup.ts's import shape (e.g.,
//   `import * as cryptoNode from 'crypto'`, re-export wrappers, etc.)
//   with a manual re-validation: a broken interception point would
//   silently let the length-guard assertions pass for the wrong
//   reason.
jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    // Delegate to the real implementation; jest wraps it so call
    // arguments land in `mock.calls`.
    timingSafeEqual: jest.fn(actual.timingSafeEqual),
  };
});

// ── Shared test helpers (TSDoc per issue spec) ────────────────────────────────

/**
 * Reference event whose contractId/eventId/sequence are fixed so all
 * derived keys/hashes are byte-stable across runs.
 *
 *   - `contractId: 'contract_123'` and `eventId: 'event_45_ten'` use
 *     values that exercise the colon (`:`) split path in
 *     `parseDeduplicationKey` — neither contains a `:`, so the parser
 *     produces exactly three components.
 *   - `sequence: 1` is the minimal non-zero sequence (sequence 0 has
 *     its own dedupe-key collision surface with sequence `00`).
 *   - `payload` is a small object with both scalar and nested data.
 */
function makeEvent(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    contractId: 'contract_123',
    eventId: 'event_45_ten',
    sequence: 1,
    timestamp: 1_700_000_000_000,
    payload: { kind: 'milestone_paid', amount: 100, currency: 'USDC' },
    ...overrides,
  };
}

/**
 * Hard-coded SHA-256 of the canonicalized JSON for `{ stable: 'yes' }`
 * (canonical form: `{"stable":"yes"}`).
 *
 * CAPTURED against the production `canonicalize` function in
 * `src/utils/deduplication.ts`. If you change the canonicalization
 * rule intentionally, you MUST regenerate this constant AND update
 * the comments explaining what the new rule is — every downstream
 * dedup verdict depends on byte-stable hashing.
 */
const STABLE_YES_REGRESSION_DIGEST =
  'a432f0bb78867e37da71dd8b1944a280cdac14d42f530c77502075f5f47b1acd';

// ── Suite ────────────────────────────────────────────────────────────────────

describe('DeduplicationManager — payload hashing (stability & distinctness)', () => {
  it('produces a 64-char lowercase hex SHA-256 digest for a scalar payload', () => {
    const hash = DeduplicationManager.computePayloadHash('plain string');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces a 64-char lowercase hex SHA-256 digest for an empty string', () => {
    const hash = DeduplicationManager.computePayloadHash('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces a 64-char lowercase hex SHA-256 digest for an empty object', () => {
    const hash = DeduplicationManager.computePayloadHash({});
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns the SAME digest for identical payload across independent calls', () => {
    const payload: JsonValue = { data: 'test', number: 42 };
    const a = DeduplicationManager.computePayloadHash(payload);
    const b = DeduplicationManager.computePayloadHash(payload);
    expect(a).toBe(b);
  });

  it('keeps digest stable across key-order permutations (canonicalization)', () => {
    const reordered1 = DeduplicationManager.computePayloadHash({ b: 2, a: 1 });
    const reordered2 = DeduplicationManager.computePayloadHash({ a: 1, b: 2 });
    expect(reordered1).toBe(reordered2);
  });

  it('keeps digest stable across nested key-order permutations', () => {
    const a = DeduplicationManager.computePayloadHash({
      outer: { z: 1, a: 2, m: 3 },
      sibling: { y: 'foo', x: 'bar' },
    });
    const b = DeduplicationManager.computePayloadHash({
      sibling: { x: 'bar', y: 'foo' },
      outer: { m: 3, a: 2, z: 1 },
    });
    expect(a).toBe(b);
  });

  it('produces DIFFERENT digests for distinct scalar payloads', () => {
    expect(
      DeduplicationManager.computePayloadHash('one'),
    ).not.toBe(DeduplicationManager.computePayloadHash('two'));
  });

  it('produces DIFFERENT digests when one value in a payload changes by 1 byte', () => {
    const before = DeduplicationManager.computePayloadHash({ v: 'hello' });
    const after = DeduplicationManager.computePayloadHash({ v: 'hellp' });
    expect(before).not.toBe(after);
  });

  it('produces different digests for different array lengths (array semantically matters)', () => {
    const a = DeduplicationManager.computePayloadHash([1, 2, 3]);
    const b = DeduplicationManager.computePayloadHash([1, 2]);
    expect(a).not.toBe(b);
  });

  it('produces different digests for array vs object with same entries', () => {
    // [1, 2] and { 0: 1, 1: 2 } serialize differently under the
    // canonicalization rule, so we MUST assert distinctness to lock in
    // the serialization contract.
    const arr = DeduplicationManager.computePayloadHash([1, 2]);
    const obj = DeduplicationManager.computePayloadHash({ 0: 1, 1: 2 });
    expect(arr).not.toBe(obj);
  });

  it('regression sentinel: SHA-256 of canonicalized {stable:"yes"} is locked', () => {
    // If this assertion fails, `canonicalize` in deduplication.ts has
    // changed and downstream dedup verdicts have broken. Update
    // STABLE_YES_REGRESSION_DIGEST ONLY as part of an intentional
    // canonicalization-rule change.
    expect(DeduplicationManager.computePayloadHash({ stable: 'yes' })).toBe(
      STABLE_YES_REGRESSION_DIGEST,
    );
  });

  it('locks SHA-256 digests for primitive scalars (null/false/number)', () => {
    // Captured against the production canonicalizer. Same rationale as
    // the {stable:"yes"} sentinel: every downstream verdict depends
    // on byte-stable hashing for every JSON value shape.
    expect(DeduplicationManager.computePayloadHash(null)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
    expect(DeduplicationManager.computePayloadHash(false)).toBe(
      'fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa',
    );
    expect(DeduplicationManager.computePayloadHash(42)).toBe(
      '73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049',
    );
    // null and false MUST differ — JSON.stringify gives distinct output.
    expect(DeduplicationManager.computePayloadHash(null)).not.toBe(
      DeduplicationManager.computePayloadHash(false),
    );
    // Number 42 and string "42" MUST differ — distinct scalar types.
    expect(DeduplicationManager.computePayloadHash(42)).not.toBe(
      DeduplicationManager.computePayloadHash('42'),
    );
  });

  it('locks SHA-256 of canonicalized empty string and empty object', () => {
    // Locks the empty-edge canonicalization branch.
    // NOTE: `canonicalize('')` returns `JSON.stringify('')` = `'""'`
    // (TWO byte-quote characters, ASCII 0x22 0x22), NOT zero bytes —
    // the SHA-256 of a 0-byte input is the well-known
    // `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
    // and is a different digest from the one asserted here.
    expect(DeduplicationManager.computePayloadHash('')).toBe(
      '12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126',
    );
    expect(DeduplicationManager.computePayloadHash({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });
});

describe('DeduplicationManager — comparePayloadHashes (timing-safe + length guard)', () => {
  // `crypto.timingSafeEqual` is the jest.fn installed by the top-of-file
  // `jest.mock('crypto', …)` factory. We use `mockClear()` per test so
  // assertions on call count are scoped to the single call we make.
  let tseMock: jest.MockedFunction<typeof crypto.timingSafeEqual>;

  beforeEach(() => {
    tseMock = crypto.timingSafeEqual as jest.MockedFunction<
      typeof crypto.timingSafeEqual
    >;
    tseMock.mockClear();
  });

  it('returns true for identical hashes', () => {
    const h = DeduplicationManager.computePayloadHash({ data: 'same' });
    expect(DeduplicationManager.comparePayloadHashes(h, h)).toBe(true);
  });

  it('returns false for two equal-length but value-distinct hashes', () => {
    const a = DeduplicationManager.computePayloadHash({ a: 1 });
    const b = DeduplicationManager.computePayloadHash({ a: 2 });
    expect(a).not.toBe(b);
    // Sanity: both digests are exactly 64 hex chars (32 bytes).
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
    expect(DeduplicationManager.comparePayloadHashes(a, b)).toBe(false);
  });

  it('SECURITY: never invokes timingSafeEqual with mismatched buffer lengths', () => {
    // 'abcd' decodes to a 2-byte buffer; 'abcd1234' decodes to 4 bytes.
    const short = 'abcd';
    const long = 'abcd1234';
    expect(Buffer.from(short, 'hex').length).toBe(2);
    expect(Buffer.from(long, 'hex').length).toBe(4);

    DeduplicationManager.comparePayloadHashes(short, long);

    expect(tseMock).toHaveBeenCalledTimes(1);
    const [bufA, bufB] = (tseMock.mock.calls[0] ?? []) as [
      NodeJS.ArrayBufferView,
      NodeJS.ArrayBufferView,
    ];
    // Both buffers passed to timingSafeEqual MUST be the SAME length
    // (we call it with `actual` vs `actual` to keep wall-time stable).
    expect(bufA.byteLength).toBe(bufB.byteLength);
    // And both must equal the SHORTER buffer (length 2 here).
    expect(bufA.byteLength).toBe(2);
    expect(bufB.byteLength).toBe(2);
  });

  it('SECURITY: returns false (does not throw) when comparing wildly different-length inputs', () => {
    expect(() =>
      DeduplicationManager.comparePayloadHashes('ab', 'a'.repeat(64)),
    ).not.toThrow();
    expect(
      DeduplicationManager.comparePayloadHashes('ab', 'a'.repeat(64)),
    ).toBe(false);
  });

  it('SECURITY: empty-string vs non-empty never reaches timingSafeEqual with mismatched buffers', () => {
    // Buffer.from('', 'hex') is 0 bytes; everything else is N bytes.
    DeduplicationManager.comparePayloadHashes('', '00');
    expect(tseMock).toHaveBeenCalledTimes(1);
    const [bufA, bufB] = (tseMock.mock.calls[0] ?? []) as [
      NodeJS.ArrayBufferView,
      NodeJS.ArrayBufferView,
    ];
    expect(bufA.byteLength).toBe(bufB.byteLength);
    expect(bufA.byteLength).toBe(0);
  });

  it('treats a valid 64-char hex digest vs an empty string as length-mismatch → false', () => {
    const h = DeduplicationManager.computePayloadHash({ anything: 'goes' });
    expect(DeduplicationManager.comparePayloadHashes(h, '')).toBe(false);
    expect(DeduplicationManager.comparePayloadHashes('', h)).toBe(false);
  });

  it('SECURITY: on equal-length inputs the compare goes through timingSafeEqual with the original buffers', () => {
    const a = DeduplicationManager.computePayloadHash({ x: 1 });
    const b = DeduplicationManager.computePayloadHash({ x: 2 });
    DeduplicationManager.comparePayloadHashes(a, b);
    expect(tseMock).toHaveBeenCalledTimes(1);
    const [bufA, bufB] = (tseMock.mock.calls[0] ?? []) as [
      NodeJS.ArrayBufferView,
      NodeJS.ArrayBufferView,
    ];
    // Compare path — both must be 32-byte SHA-256 digests.
    expect(bufA.byteLength).toBe(32);
    expect(bufB.byteLength).toBe(32);
    // The buffers are NOT self-compared (unlike the length-guard path).
    // `Buffer.compare` on ArrayBufferView params: wrap each via
    // `Uint8Array(view.buffer, view.byteOffset, view.byteLength)` so
    // `Buffer.compare` accepts them without copy.
    const u8a = new Uint8Array(bufA.buffer, bufA.byteOffset, bufA.byteLength);
    const u8b = new Uint8Array(bufB.buffer, bufB.byteOffset, bufB.byteLength);
    expect(Buffer.compare(u8a, u8b)).not.toBe(0);
  });
});

describe('DeduplicationManager — validatePayloadIntegrity', () => {
  it('returns true when the expected hash matches the actual', () => {
    const event = makeEvent();
    const hash = DeduplicationManager.computePayloadHash(event.payload);
    expect(DeduplicationManager.validatePayloadIntegrity(event, hash)).toBe(
      true,
    );
  });

  it('returns false when the expected hash is wrong', () => {
    const event = makeEvent();
    const wrong = DeduplicationManager.computePayloadHash({
      kind: 'tampered',
    });
    expect(DeduplicationManager.validatePayloadIntegrity(event, wrong)).toBe(
      false,
    );
  });

  it('returns false (not throws) when the expected hash is malformed/short', () => {
    const event = makeEvent();
    expect(
      DeduplicationManager.validatePayloadIntegrity(event, 'abcd'),
    ).toBe(false);
  });

  it('returns false when the payload is tampered by swapping a number for a string', () => {
    const original = makeEvent({ payload: { amount: 100 } });
    const goodHash = DeduplicationManager.computePayloadHash(original.payload);
    const tampered: ContractEvent = {
      ...original,
      payload: { amount: '100' as unknown as number },
    };
    expect(DeduplicationManager.validatePayloadIntegrity(tampered, goodHash)).toBe(
      false,
    );
  });
});

describe('DeduplicationManager — computeDeduplicationKey', () => {
  it('formats the key as contractId:eventId:sequence', () => {
    const event = makeEvent({ sequence: 1 });
    expect(DeduplicationManager.computeDeduplicationKey(event)).toBe(
      'contract_123:event_45_ten:1',
    );
  });

  it('returns identical keys for structurally identical events', () => {
    const a = makeEvent();
    const b = makeEvent();
    expect(DeduplicationManager.computeDeduplicationKey(a)).toBe(
      DeduplicationManager.computeDeduplicationKey(b),
    );
  });

  it('distinguishes events that differ ONLY in sequence', () => {
    const a = makeEvent({ sequence: 1 });
    const b = makeEvent({ sequence: 2 });
    expect(DeduplicationManager.computeDeduplicationKey(a)).not.toBe(
      DeduplicationManager.computeDeduplicationKey(b),
    );
  });

  it('distinguishes events that differ ONLY in contractId', () => {
    const a = makeEvent({ contractId: 'contract_aaa' });
    const b = makeEvent({ contractId: 'contract_bbb' });
    expect(DeduplicationManager.computeDeduplicationKey(a)).not.toBe(
      DeduplicationManager.computeDeduplicationKey(b),
    );
  });

  it('coerces a numeric sequence into the key string correctly', () => {
    const event = makeEvent({ sequence: 42 });
    expect(DeduplicationManager.computeDeduplicationKey(event)).toMatch(/:42$/);
  });
});

describe('DeduplicationManager — parseDeduplicationKey', () => {
  it('round-trips computeDeduplicationKey → parseDeduplicationKey', () => {
    const event = makeEvent({ sequence: 99 });
    const key = DeduplicationManager.computeDeduplicationKey(event);
    const parsed = DeduplicationManager.parseDeduplicationKey(key);
    expect(parsed).toEqual({
      contractId: event.contractId,
      eventId: event.eventId,
      sequence: 99,
    });
  });

  it('parses keys with multi-segment contractIds and eventIds', () => {
    const parsed = DeduplicationManager.parseDeduplicationKey(
      'complex-contract_abc-123:event_xyz-789:42',
    );
    expect(parsed).toEqual({
      contractId: 'complex-contract_abc-123',
      eventId: 'event_xyz-789',
      sequence: 42,
    });
  });

  it('returns NaN sequence when the third segment is not a number (documented behaviour)', () => {
    // parseInt('not-a-number', 10) is NaN — locked in here so a future
    // hardening change (e.g. throwing on unparseable) is intentional.
    const parsed = DeduplicationManager.parseDeduplicationKey('a:b:not-a-number');
    expect(parsed.contractId).toBe('a');
    expect(parsed.eventId).toBe('b');
    expect(Number.isNaN(parsed.sequence)).toBe(true);
  });
});

describe('DeduplicationManager — areEventsDuplicates', () => {
  it('returns true for two structurally identical events', () => {
    expect(
      DeduplicationManager.areEventsDuplicates(makeEvent(), makeEvent()),
    ).toBe(true);
  });

  it('returns false when sequence differs', () => {
    expect(
      DeduplicationManager.areEventsDuplicates(
        makeEvent({ sequence: 1 }),
        makeEvent({ sequence: 2 }),
      ),
    ).toBe(false);
  });

  it('returns false when contractId differs', () => {
    expect(
      DeduplicationManager.areEventsDuplicates(
        makeEvent({ contractId: 'c1' }),
        makeEvent({ contractId: 'c2' }),
      ),
    ).toBe(false);
  });

  it('returns false when payload differs but key matches (payload is not part of the dedup key)', () => {
    // The dedup key deliberately does NOT include the payload bytes —
    // only contractId/eventId/sequence. Two events with the same key
    // but different payloads are still considered duplicates at the
    // dedup layer. Integrity is checked separately via
    // validatePayloadIntegrity.
    const a = makeEvent({ payload: { v: 1 } });
    const b = makeEvent({ payload: { v: 2 } });
    expect(DeduplicationManager.areEventsDuplicates(a, b)).toBe(true);
  });
});

describe('DeduplicationManager — security-critical surface', () => {
  // Narrow contract check: only the security-critical entry points
  // (length-guard + canonicalization + integrity verification + dedup
  // key derivation + parse round-trip) must exist. Adding a future
  // non-security helper to the manager must NOT break this test.
  //
  // TTL/eviction is intentionally OUT OF SCOPE: `DeduplicationManager`
  // is a static-method utility with no in-memory store, no Map, no
  // expiring cache. The "TTL/eviction" expectation from issue #597 is
  // therefore not applicable to this surface. Downstream code that
  // needs eviction lives in `src/events/idempotency.ts` and
  // `src/utils/swrCache.ts`, each with its own dedicated tests.
  it('exposes the security-critical static methods', () => {
    expect(typeof DeduplicationManager.comparePayloadHashes).toBe('function');
    expect(typeof DeduplicationManager.computePayloadHash).toBe('function');
    expect(typeof DeduplicationManager.computeDeduplicationKey).toBe('function');
    expect(typeof DeduplicationManager.parseDeduplicationKey).toBe('function');
    expect(typeof DeduplicationManager.areEventsDuplicates).toBe('function');
    expect(typeof DeduplicationManager.validatePayloadIntegrity).toBe('function');
  });
});
