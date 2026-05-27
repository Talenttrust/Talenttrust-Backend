# Event Ingestion Idempotency

Event ingestion binds each idempotency key to a stable hash of the JSON payload.
The first request for a key runs the event handler, stores the handler result,
and persists the canonical SHA-256 payload hash with the key in `src/db`.

When the same key is received again:

- If the canonical payload hash matches, ingestion returns the cached result and
  treats the duplicate as a no-op.
- If the hash differs, ingestion rejects the request with
  `IdempotencyConflictError`, which is safe to translate to HTTP `409 Conflict`.

The canonicalizer sorts object keys recursively while preserving array order, so
payloads with the same JSON meaning hash identically even when object properties
arrive in a different order. Hash comparison uses `crypto.timingSafeEqual` to
avoid data-dependent comparison timing.

Conflict logs include the idempotency key and hashes only. Payload bodies are
replaced with the payload redaction marker from `src/events/redact.ts`; secret
metadata fields such as tokens, signatures, passwords, and API keys are also
redacted before logging.

Security assumptions:

- Event payloads passed to idempotency are already JSON-compatible and validated
  by the ingestion boundary.
- Authentication and signature verification must happen before the idempotent
  handler commits side effects.
- Secrets stay in `.env` files or deployment secret stores and are never stored
  in idempotency records.
- Durable production stores should enforce a unique index on the idempotency key
  and persist `key`, `payloadHash`, cached `result`, and `createdAt`.
