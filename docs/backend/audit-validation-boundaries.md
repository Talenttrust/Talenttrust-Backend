# Audit input validation boundaries

`validateCreateAuditEntryInput` accepts unknown input and returns a validation
result without throwing. Accepted metadata is copied into a JSON snapshot; later
changes to the caller's nested objects cannot change the validated entry. Shared
non-circular branches are accepted and copied independently. Validation is pure
with respect to ordinary data objects, not a sandbox for arbitrary Proxy traps.

The single-entry POST audit route now uses this boundary. Configured access
middleware runs before validation and idempotent replay. Validation leaves
`req.body` unchanged: omitting metadata and explicitly supplying `{}` still have
different original-body idempotency hashes. Only successful writes are cached;
validation failures and failed writes leave the key available for a corrected
request or retry. A store failure produces a fixed 500 message rather than
echoing its arbitrary error payload. This does not provide transactional recovery
if a custom service commits an entry and subsequently throws; the service owns
atomic append behavior and durable deduplication.

## Accepted input and limits

Required fields remain action, severity, actor, resource and resourceId. Metadata
defaults to `{}`. Existing action/severity lists, identifier, IP/correlation ID,
key-count, array-count, depth, string-length, number-magnitude and 16 KiB serialized
metadata bounds remain in force. Exact limits are accepted; one unit beyond a
limit is rejected. The metadata byte measurement uses the snapshot's serialized
UTF-8 representation.

Metadata objects must have the standard object prototype or a null prototype.
Arrays must have explicit data values at each index. Dates, Maps, Sets, custom
object prototypes, accessors, cycles, non-JSON values and forbidden prototype keys
are rejected. Serialization hooks are never invoked. Non-enumerable object
properties are omitted from the snapshot, consistent with ordinary JSON data.
Validation visits at most 16,384 metadata values and reports at most 64 issues,
bounding expansion of shared or invalid trees. These are local validation bounds;
HTTP body-size limits and upstream authentication remain separate responsibilities.

## Compatibility and migration

Public function signatures, successful response shapes, omitted metadata defaults,
and stable error codes remain available. The old `createAuditEntryBodySchema`
export is retained for existing callers; it is not the live POST write boundary.
The bulk endpoint retains its separate contract and is not changed here.

POST callers must remove unknown fields instead of relying on silent stripping,
send valid bounded identifiers/IP/correlation IDs, and keep metadata inside the
documented JSON limits. Non-HTTP producers should convert Dates to strings,
Maps/Sets to plain records/arrays, and accessors to data properties before calling
the validator. A successful result owns an independent mutable snapshot rather
than aliases into the supplied object. Snapshot metadata objects have null
prototypes; read them with `Object.keys`, `Object.hasOwn` or JSON serialization
rather than instance methods inherited from `Object.prototype`.

Failure details retain their codes and normal field paths. Oversized, multiline or
unsafe property-name segments are represented as `<key>`; clients should use
codes rather than matching echoed property names. Messages do not include field
values or exception payloads. Configured authorization remains authoritative even
when a client presents a key for a previously successful request.
