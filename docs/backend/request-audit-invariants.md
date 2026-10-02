# Request audit helper invariants

`auditMiddleware` attaches the existing synchronous `res.locals.audit.log(input)`
API. It snapshots `AUDIT_ENABLED`, the Express-resolved IP (or socket fallback),
and the sanitized `X-Correlation-ID` when the request enters the middleware.
Configure Express `trust proxy` only for trusted proxies; the helper does not
read `X-Forwarded-For` itself. Event input cannot override the captured context.
Missing, array-valued, oversized, or unsafe correlation IDs are omitted using
the shared correlation-ID utility (letters, digits, hyphen, underscore; 1–128
characters).

## Validation and immutable state

Before calling the service, the helper validates action, severity, identifiers,
and metadata using the audit write schema's existing bounds. All actions in the
public `AuditAction` type remain accepted, including contract deletion and
milestone actions that the HTTP write schema does not yet include. The HTTP
endpoint's schema is unchanged. Unknown extra input properties are discarded.

Metadata must be a bounded JSON object: identifiers have a 128-character limit,
metadata depth is at most five, objects at most 50 keys, arrays at most 200 items,
strings at most 4,096 characters, and serialized metadata at most 16 KiB. Cycles,
non-finite/unsafe numbers, non-JSON values, and prototype-pollution keys are
rejected. See `src/audit/inputValidation.ts` for the shared rules.

The helper validates, copies through JSON serialization, revalidates the copy,
redacts sensitive keys and email values with the existing audit redactor, and
deeply freezes the resulting metadata. The redacted result is validated again
so redaction cannot exceed storage bounds. This isolates the stored hash from
later changes to caller-owned nested objects and arrays. Caller data is neither
redacted in place nor frozen. Invalid inputs and throwing getters produce a
static `AppError(400, 'validation_error', 'Invalid audit event')`, without raw
input or exception text. Rejection happens before any write.

## Transitions, failures, and repeated operations

The helper records facts supplied by authorized application code. It neither
grants permissions nor performs business transitions; routes must enforce those
invariants before logging successful mutations. An authorization rejection does
not automatically append a mutation event. Callers may explicitly log a failed
authentication or other rejection event.

Each valid enabled `log()` call performs one immediate synchronous append and
returns the persisted entry. Storage exceptions still propagate to the caller
and the existing HTTP error handler. There is no buffering, implicit retry,
cross-request deduplication, or write on response completion. Two identical calls
represent two events, with distinct IDs and successive hash links. Correlation
IDs identify tracing context, not an idempotency key. An explicit retry is the
caller's decision; the helper cannot resolve an ambiguous repository failure
after a commit. It also cannot atomically roll back a separate business write.

Each request has its own helper and captured context. Interleaved requests do
not share metadata or correlation state. Turning the flag on or off during a
request does not change that request's helper.

## Compatibility

The exported middleware and helper signatures, synchronous return, service error
propagation, and disabled stub IDs/hashes remain unchanged. The disabled helper
still returns an entry with empty `id`, `hash`, and `previousHash`, without
persistence. Its metadata and returned stub are now immutable.

The validation and sanitization changes intentionally reject previously accepted
invalid audit data, including when auditing is disabled. Existing valid typed
callers require no API migration. Producers passing oversized/non-JSON metadata
must supply bounded JSON values; code mutating returned metadata must instead
mutate its own source data. Secrets are redacted and unsafe correlation IDs are
omitted rather than persisted verbatim.

## Verification

Regression tests in `src/audit/middleware.invariants.test.ts` use the real
in-memory store to check hash integrity after source mutation, repeated and
interleaved operations, rejection before append, and recovery after a failed
append. HTTP tests exercise forbidden routes and the safe error response after
a failed write. Existing middleware, feature-flag, protected endpoint, input
validation, and correlation-ID suites check compatibility.

```sh
npm test -- --runInBand --runTestsByPath src/audit/middleware.invariants.test.ts src/audit/middleware.test.ts src/audit/audit.flag.test.ts src/audit/protectedEndpointMiddleware.test.ts src/audit/inputValidation.test.ts src/utils/correlationId.test.ts
```

These checks cover the helper's guarantees, not repository-wide concurrency,
durability, or business/audit transaction atomicity.
