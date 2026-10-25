# Protected endpoint audit validation

Mount `createProtectedEndpointAuditMiddleware(service)` after body parsing and
before authentication on the protected router. The public factory and singleton
interfaces are unchanged. The middleware observes requests; it does not authorize
them or change their response. `AUDIT_ENABLED=false` still skips all audit work.

## Invariants and boundaries

- Method, original path, headers, parsed body and query are captured at ingress.
  Router mount prefixes remain part of the path. Query strings and fragments are
  excluded from that path; encoded segments are retained without decoding.
- The authenticated actor and final status are resolved on response `finish`.
  GET/HEAD are access actions; other HTTP token methods are mutations. Status
  401/403 takes priority as `AUTH_FAILED`. Errors and rejected audit context have
  WARNING severity.
- HTTP methods must be tokens of 1–32 characters, paths absolute and at most
  4096 characters, and final status an integer from 100 through 599. Invalid
  method/path/status becomes `UNKNOWN`/`[INVALID]`/`null`.
- Actor/resource identifiers are nonblank strings of at most 128 characters,
  without control characters. Invalid actor becomes `anonymous`; invalid
  resource/type segments become `endpoint`/empty ID. Optional correlation IDs
  use `[A-Za-z0-9._:-]`, at most 128 characters. IPs must be valid IPv4/IPv6,
  at most 45 characters. Invalid optional context is omitted.
- Headers accept strings or string arrays; query must be a plain object. Body
  accepts plain JSON data. Each section has at most 5 container levels, 50 keys
  per object, 200 items per array, 64 characters per key, 4096 characters per
  string, 1000 traversed nodes and 8192 UTF-8 bytes after redaction. Numbers must
  be finite and within `Number.MAX_SAFE_INTEGER` magnitude. Forbidden prototype
  keys, accessors, cycles, sparse arrays and non-JSON values reject the section.
  Shared subobjects are permitted and copied independently.
- Existing sensitive-header/key rules and email masking are applied before
  persistence. Sensitive fields are discarded before reading their values.
  All retained containers are detached and frozen; subsequent handler changes
  cannot alter a stored entry or its hash. Free text is not a general PII filter.

## Failure, duplicate and compatibility behavior

Rejected payload sections become `[OMITTED]`; `metadata.auditValidation` lists
affected field names without their values. A summary entry is retained where
possible, rather than dropping the entire audit event because of a cyclic or
oversized body. These are audit validation outcomes, not HTTP validation errors.
Large/custom payloads previously accepted by this observer now receive explicit
omission markers; consumers must allow these markers. Normal JSON metadata and
action mapping remain compatible. Empty query metadata remains `null`.

One response/service pair owns one finish listener across repeated mounts or
factory calls. Separate services remain independent. Every HTTP retry is a new
auditable request, even with the same request ID; correlation IDs are not global
deduplication keys. Concurrent requests do not share mutable snapshots.

Persistence exceptions are still rethrown by `AuditService` for callers that
handle them, but its diagnostic now contains only `audit_persist_failed`.
The observer catches failures and reports `protected_audit_write_failed` without
raw exception messages, stacks or request data. It never retries a terminal
write: an exception might occur after persistence, making a retry ambiguous.
A later request can write normally. This is best-effort finish auditing, not a
durable exactly-once delivery guarantee; aborted responses and storage outages
require separate operational handling.

## Verification

`protectedEndpointValidation.test.ts` covers accepted/rejected/exact-limit
inputs, redaction, immutable copies, mounted routers, duplicate listeners,
concurrent requests, sanitized persistence failures and subsequent recovery.
The existing protected endpoint, feature flag and service suites cover public
compatibility and action/auth behavior.
