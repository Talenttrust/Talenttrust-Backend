# Audit idempotency store invariants

`src/audit/idempotency.ts` is a synchronous, process-local store of completed
audit responses. The audit HTTP router currently uses the separate middleware
in `src/middleware/idempotency.ts`; this change does not replace that middleware
or its authorization/validation chain.

## State transitions

| Current state | Operation | Result |
| --- | --- | --- |
| Absent or expired | `set(key, input, response)` | Publish an immutable response bound to the payload fingerprint |
| Live, equivalent payload | `set` | Keep the first response and original creation time; do not reorder eviction |
| Live, different payload | `set` | Throw `AuditIdempotencyError` with `audit_idempotency_conflict`; keep all records |
| Any | Invalid key, payload, response, or clock | Reject before insertion or eviction; error code `audit_idempotency_invalid_input` |
| Live | `get` | Return a deeply frozen snapshot; no caller aliases are retained |
| At or beyond TTL | `get`, `size`, or successful `set` | Expire the binding |
| Live | Authorized `delete` / `clear` by the owning caller | Intentionally release the binding |
| Capacity reached | Successful new insertion | Evict the oldest live insertion after expired records are removed |

Preparation (including JSON copying, hashing and response/payload matching)
finishes before modifying the map. No asynchronous work or caller-controlled
serialization runs between inspecting and publishing a record. Rejected writes
cannot evict an unrelated live response, even at capacity.

The fingerprint covers action, severity, actor, resource, resource ID and
metadata. Object key order is ignored recursively; array order is significant.
IP address and correlation ID remain excluded so retries with different
transport context still match. Non-JSON data, cycles, accessors, sparse arrays,
symbol keys and nesting beyond 64 containers reject instead of silently losing
fingerprint content. Snapshots contain only JSON data, use prototype-free
objects, and are recursively frozen.

Keys are nonblank strings of at most 256 characters without control characters.
Capacity and TTL must be positive safe integers. Expiry is inclusive at the
exact TTL boundary. Observed time never moves backward for an instance; a
wall-clock rollback may delay expiry until time catches up but cannot rejuvenate
an already aged record. No background timers or shared/global clock changes are
introduced.

## Compatibility and migration

Public method signatures and the record fields remain unchanged. The store now
rejects conflicting overwrites; equivalent replays retain the original result.
A caller intentionally replacing a completed operation must first authorize and
perform `delete(key)` (or wait for expiry), then `set` the replacement. The tests
exercise this migration. Mutating returned records is no longer supported;
modify application-owned data instead. Canonical fingerprints change, but this
store has no persisted records to migrate across process restarts.

This store does not execute or reserve an in-flight business operation. Callers
must authorize before lookup, namespace keys within their tenant/actor scope,
validate application inputs, and complete the operation before publishing its
response. It does not grant access to a response merely because a key matches.
The actor/resource fingerprint prevents conflicting replacement, while access
control remains the caller's responsibility. `delete` and `clear` are internal
maintenance operations and must not be exposed to unauthenticated callers.

FIFO eviction, explicit deletion, expiry and process restart end the replay
guarantee. Separate instances do not coordinate; durable cross-process
idempotency requires the application's existing repository/middleware flow.
Errors contain stable codes and fixed messages without keys, actor IDs or
metadata; callers can map these to their existing error envelope.
