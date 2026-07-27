# test(utils): cover timing-safe deduplication manager (#597)

## Problem

`DeduplicationManager` in `src/utils/deduplication.ts` is a
security-sensitive surface: it hashes event payloads with SHA-256 and
compares them using `crypto.timingSafeEqual` through an explicit
equal-length guard. The constant-time comparison branches on whether
the buffer lengths match before delegating to `timingSafeEqual`, both
to avoid the `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` throw and to close a
length-based timing side-channel.

Yet the file had no Jest-picked-up test (`jest.config.js` has
`roots: ['<rootDir>/src']`, so an existing orphan test under
`tests/utils/` was never run). Issue #597 asks for focused coverage of
hashing, equal/unequal payload comparison, the length-guard branch, and
TTL/eviction behavior.

This PR closes that gap.

## What's tested

### New file: `src/utils/deduplication.test.ts`

Picked up by Jest's `roots: ['<rootDir>/src']`. No source changes —
pure test addition. Coverage targets:

- **Hash stability**
  - Same payload → same 64-char lowercase hex digest across calls
  - Key-order permutations of objects produce identical digests
    (canonicalization)
  - Nested key permutations at multiple levels
  - Different scalar payloads → different digests
  - 1-byte mutation in a payload value → different digest
  - Empty string and empty object edges
  - Primitive scalars (`null` / `false` / `42`) and booleans vs numbers

- **Hash stability is locked via Golden Vectors**
  - Five hard-coded digests (SHA-256 of `{ stable: 'yes' }`,
    `null`, `false`, `42`, `''`, `{}`) act as regression sentinels.
    If `canonicalize` ever changes intentionally, the sentinels MUST
    be regenerated. The empty-string case is annotated with an inline
    NOTE distinguishing `'""'` (two byte-quote characters) from the
    well-known SHA-256 of zero bytes — the two have very different
    digests.

- **Constant-time comparison (`comparePayloadHashes`)**
  - Identical hashes → `true`
  - Equal-length but value-distinct hashes → `false`
  - Different-length inputs → `false` without throwing; the spy on
    `crypto.timingSafeEqual` verifies the length-guard path passes
    only same-length buffers (the `actual, actual` self-comparison)
  - Empty-string vs non-empty triggers the length guard (0-byte vs
    1+ byte buffers)
  - SECURE invariant: `timingSafeEqual` is never called with two
    mismatched-length buffers in any test branch

- **Spy shape note**
  The TSDoc at the top of the test file documents that the
  `crypto.timingSafeEqual` spy depends on the source doing
  `import { timingSafeEqual } from 'crypto'` (destructured named
  import). A future refactor to a non-destructured shape would
  silently neuter the spy — flagged for future reviewers.

- **Payload integrity (`validatePayloadIntegrity`)**
  - Valid → `true`
  - Wrong hash → `false`
  - Malformed short expected hash → `false` (not throws)
  - Tampered payload (number swapped for string) → `false`

- **Dedup key derivation / parsing**
  - Stable key format `contractId:eventId:sequence`
  - Round-trip via `parseDeduplicationKey`
  - Distinguishes events that differ only in sequence / contractId
  - `areEventsDuplicates` deliberately ignores payload bytes
    (identity key vs. integrity hash are separate concerns)

- **Surface contract**
  Narrow contract test asserts all six security-critical static
  methods exist (`comparePayloadHashes`, `computePayloadHash`,
  `computeDeduplicationKey`, `parseDeduplicationKey`,
  `areEventsDuplicates`, `validatePayloadIntegrity`).

### Modified: `src/utils/deduplication.ts`

Behavior unchanged. TSDoc pass only:

- Module-level doc explains the security model (canonical hashing +
  constant-time comparison) and the rationale for having no TTL or
  eviction surface here (eviction lives in
  `src/events/idempotency.ts`).
- Class-level TSDoc with a one-paragraph security model.
- Per-method rationale TSDoc, with `comparePayloadHashes` spelling
  out the length-guard + self-comparison mechanism and the
  `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` tradeoff.
- `canonicalize` helper got a brief doc describing the canonical JSON
  format and clarifying that the output round-trips through
  `JSON.parse` cleanly.

## Why TTL / eviction is intentionally out of scope

`DeduplicationManager` is a stateless, static-method utility. It owns
no in-memory store, Map, or expiring cache — there is nothing here
to evict. The "TTL/eviction" expectation from the issue therefore
does not apply to this surface, and the test file documents that with
an in-line comment naming the downstream modules that DO have TTL
semantics (`src/events/idempotency.ts`,
`src/utils/swrCache.ts`).

## Security notes (per issue template)

- The hashing layer uses SHA-256 with a canonicalization step that
  sorts object keys at every nesting level. Without this,
  independent JSON encoders would produce different integrity
  verdicts for the same logical payload, breaking downstream dedupe.
- The constant-time comparison is enforced at every call site:
  - The length guard short-circuits to `false` for mismatched
    buffers but still pays the wall-time cost of a self-comparison
    so an attacker cannot distinguish length mismatch from
    same-length mismatch by timing alone.
  - The shared `Buffer.from(x, 'hex')` calls produce no early leak
    of length — buffers are constructed before length comparison.
- The test asserts (via spy-mocking) that `timingSafeEqual` is
  NEVER called with two buffers of different lengths. This is the
  load-bearing invariant of the length-guard mechanism.

## Coverage goal

≥ 95 % statements / branches / functions / lines for
`src/utils/deduplication.ts`. The test exercises every public
method plus both branches of the comparison helper (length-guard
and equal-length).

## Test execution

```bash
# Run the new test file in isolation
npx jest --runInBand src/utils/deduplication.test.ts

# Full pre-merge CI gate (per issue template)
npm run lint
npm run test:ci
```

## Out of scope

- Coordinator-level tests asserting dedup at the route/integration
  level (those belong in `tests/integration/` and are unrelated to
  the unit-level guarantees covered here).
- Adding new helpers to `DeduplicationManager` — the surface
  contract test pins the existing methods only.

Closes #597
