# Protect state invariants in `src/audit/schemas.ts`

Closes #1362

## Summary

`src/audit/schemas.ts` is the HTTP-facing guard in front of the append-only,
hash-chained audit log — anything it accepts is permanent. It was, however, a
**second, weaker, hand-maintained copy** of validation rules that already exist
(and are far stricter) in `src/audit/inputValidation.ts`, and it duplicated the
`AUDIT_ACTIONS` / `AUDIT_SEVERITIES` lists that live in `src/audit/types.ts`.

That duplication had already caused a real cross-surface drift: the schema list
omitted `REPUTATION_CORRECTED`, so `POST /api/v1/audit` rejected an action that
the domain type, the strict write-path validator and the service layer all
support. The API schema also accepted unbounded identifiers, unvalidated
`ipAddress`/`correlationId`, and metadata with prototype-pollution keys, no
depth/size bounds and no JSON-serialisability guarantee.

This PR makes the invariants **owned by this module** explicit, removes the
duplication, and pins the behaviour with focused tests. It is a
behaviour-compatible hardening: existing valid payloads still pass, the
documented legacy query quirk is preserved, and no public interface changes.

## Problem

| Gap | Consequence |
| --- | --- |
| Duplicated `AUDIT_ACTIONS`/`AUDIT_SEVERITIES` | Drift: `REPUTATION_CORRECTED` was accepted by the domain and strict validator but rejected by the API schema. |
| Field rules re-declared instead of shared | `schemas.ts` accepted inputs `inputValidation.ts` rejects (unbounded IDs, arbitrary `ipAddress`, control characters). |
| `metadata: z.record(z.unknown())` | Accepted prototype-pollution keys (`__proto__`/`constructor`/`prototype`), unbounded depth/keys/size and non-JSON values into a permanent, hashed record. |
| Loose response schemas | `hash`/`previousHash`/timestamps/counters were unconstrained, so contract drift could not be caught. |

## Invariants owned by `src/audit/schemas.ts`

All of the following are now enforced by construction (shared sources, not
copied constants) and covered by tests:

1. **Enum parity with the domain.** Enums derive from `AUDIT_ACTIONS` /
   `AUDIT_SEVERITIES` in `./types` — the same arrays used by the domain types and
   by `./inputValidation`. A local copy can no longer drift.
2. **Shared field rules.** `actor`/`resource`/`resourceId`, `ipAddress`,
   `correlationId` and `metadata` are composed from the newly exported field
   schemas in `./inputValidation`, so the declarative API surface and the strict
   write-path validator cannot disagree.
3. **Structural metadata safety.** `metadata` enforces the full
   `validateMetadata` rule set: JSON-object only, depth ≤ 5, ≤ 50 keys per
   object, ≤ 200 array items, ≤ 4096 chars per string, finite numbers, no
   circular references, ≤ 16 KiB serialised, and no `__proto__` / `constructor`
   / `prototype` keys.
4. **Stable defaults and bounds.** `metadata` defaults to `{}`; identifiers are
   1–128 chars, non-blank and control-character free; `ipAddress` is a valid
   IPv4/IPv6; `correlationId` is bounded and charset-restricted.
5. **Response contracts mirror the domain types.** Response schemas now assert
   SHA-256 hash format, `GENESIS`-or-hash `previousHash`, ISO timestamps and
   non-negative integer counters.
6. **The legacy empty-string query quirk is preserved deliberately** (and
   explicitly tested): `?cursor=` is treated as absent while `?limit=` is
   rejected.

Unknown top-level body fields are still **stripped** (not rejected) to preserve
the existing API behaviour; the strict, unknown-field-rejecting variant remains
`CreateAuditEntrySchema` in `./inputValidation`.

## Acceptance-criteria mapping

| Criterion (issue #1362) | Where |
| --- | --- |
| Deterministic for valid / invalid / duplicate / boundary inputs | Shared zod schemas; boundary tests at every `MAX_*` edge (at-limit accepted, +1 rejected) |
| Validation / state-transition invariants enforced | Enum parity, bounded identifiers, IP/correlation format, full metadata matrix |
| Retries / partial failure / concurrent execution cannot produce unsafe state | Schemas are pure and stateless; metadata is JSON-serialisable and pollution-safe before it reaches the permanent store |
| Focused success / rejection / boundary / regression tests |  `src/audit/schemas.test.ts`: 29 new tests (60 total), incl. a drift regression for `REPUTATION_CORRECTED` |
| Existing callers remain compatible | Public exports preserved (incl. re-exported `AUDIT_ACTIONS`/`AUDIT_SEVERITIES`); unknown-field stripping and the empty-string quirk retained |
| Diagnosable failures without sensitive data | Structured zod `details` from the router include field paths and stable messages; metadata values are never echoed |

## Implementation notes

### `src/audit/schemas.ts`

- Imports and re-exports `AUDIT_ACTIONS` / `AUDIT_SEVERITIES` from `./types`;
  removes the drifted local arrays (public export surface unchanged).
- Composes `createAuditEntryBodySchema` from the exported field schemas in
  `./inputValidation` (`identifierSchema`, `auditMetadataSchema`,
  `ipAddressSchema`, `correlationIdSchema`).
- Tightens all response schemas to the domain contract.
- Documents the invariants in the module header.

### `src/audit/inputValidation.ts` (single source of truth)

- Exports `identifierSchema` and extracts/exports the reusable field schemas
  `ipAddressSchema`, `correlationIdSchema`, `auditMetadataSchema`.
- `CreateAuditEntrySchema` now consumes those schemas, so both validation
  surfaces share one definition. No behaviour change to the strict validator.

## Failure-mode & security handling

- **Prototype pollution:** `__proto__` / `constructor` / `prototype` are rejected
  at every nesting level before an entry can be hashed into the chain.
- **Permanent-record safety:** depth/key/array/string/byte bounds prevent an
  oversized or unserialisable entry from entering the append-only log.
- **Log integrity:** control characters are rejected in identifiers and the
  `correlationId` charset prevents CR/LF log forging.
- **Determinism:** all schemas are pure functions; no timing, randomness or I/O.

## Tests & evidence

- `npx jest src/audit/schemas.test.ts src/audit/inputValidation.test.ts` →
  **189 passed / 189** (schemas: 60, inputValidation: 129).
- `npx jest src/audit` → 10 suites pass; the only failure is the pre-existing
  `downloadTokenService.test.ts` (`no such table: audit_download_tokens`), which
  fails identically on unmodified `main` (verified by stashing this PR's
  changes; 20 failed / 1 passed).
- Focused lint on all three changed files is clean.
- Typecheck of the changed files is clean.

### New test coverage (`schemas.test.ts`)

- Enum/domain parity + `REPUTATION_CORRECTED` regression
- identifier length/blank/control-character boundaries
- IPv4/IPv6 validity and IP length bound
- `correlationId` charset/length/empty boundaries
- metadata prototype-pollution keys (top-level and nested)
- metadata depth / key-count / array-length / string-length boundaries
- non-finite numbers, circular references, serialised byte size
- shared-source agreement with `CreateAuditEntrySchema`
- query limit clamp boundaries and the preserved empty-string quirk
- response hash/timestamp/counter contract tightening

## Compatibility

- No public interface or return-type changes; `AUDIT_ACTIONS` /
  `AUDIT_SEVERITIES` remain exported (now sourced from `./types`).
- Valid existing payloads are unaffected; the only newly rejected inputs are the
  ones that violate the documented data-integrity invariants (pollution keys,
  oversized/malformed metadata, invalid IP/correlation values, over-long IDs).
- Unknown-field stripping and the legacy query quirk are explicitly preserved.

## Documentation

- `docs/backend/audit-log.md`: new “Schema & Validation Invariants” section with
  the invariant table, plus a test-suite row for `schemas.test.ts`.

## Non-goals

- No typo/formatting-only changes.
- No dependency upgrades or unrelated refactors.
- No weakening of validation or removal of safeguards — this PR only
  strengthens and de-duplicates.
