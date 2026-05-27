# Contract Event Processing

This document describes contract event ingestion, deduplication, and persistence semantics implemented for the backend test-focused pipeline.

## Scope

The current implementation is intentionally minimal and reviewable.

- Provides an in-process event handler for HTTP-ingested contract events.
- Uses deterministic dedupe identity to make replay behavior explicit.
- Uses repository abstraction with an in-memory implementation.
- Prioritizes deterministic tests and clear behavior contracts over production infrastructure.

## Event Contract

Accepted payload fields:

- `contractId` (string, non-empty)
- `eventId` (string, non-empty)
- `sequence` (non-negative integer)
- `timestamp` (parseable ISO string)
- `type` (one of `CONTRACT_CREATED`, `CONTRACT_FUNDED`, `CONTRACT_COMPLETED`, `CONTRACT_CANCELLED`)
- `payload` (JSON object)

## Processing Semantics

1. Validate payload shape and required fields.
2. Normalize identifiers (trim string fields) and keep canonical type values.
3. Build dedupe key as:

```text
contractId:eventId:sequence
```

4. Check repository for prior processing of the same key.
5. Persist event only when key is new.

## Outcome Semantics

- `accepted`: event is valid and persisted.
- `duplicate`: event identity was already processed; request is idempotent.
- `invalid`: payload violated schema or semantic constraints.
- `error`: unexpected runtime failure in processor/repository interaction.

## Threat Scenarios and Security Assumptions

1. Replay events
   - Threat: repeated event submissions attempt duplicate state transitions.
   - Mitigation: deterministic dedupe key and duplicate no-op response.
2. Malformed payload injection
   - Threat: invalid or ambiguous payloads cause undefined behavior.
   - Mitigation: strict ingress validation and structured invalid response.
3. Oversized request bodies
   - Threat: memory pressure from very large payloads.
   - Mitigation: JSON body parser size limit.
4. Storage resource exhaustion
   - Threat: unbounded in-memory growth under sustained traffic.
   - Current state: accepted non-goal for this iteration.
   - Future hardening: bounded retention, backpressure, durable storage, and operational quotas.
5. Authenticity of upstream events
   - Threat: forged events from untrusted producers.
   - Current state: not implemented in this scope.
   - Future hardening: signature verification, authenticated sources, and chain finality checks.

## Reviewer Checklist

1. Confirm tests cover accepted, duplicate, invalid, and failure paths.
2. Confirm dedupe identity matches documented key composition.
3. Confirm repository abstraction is used by processor and app wiring.
4. Confirm coverage threshold enforcement is active in Jest configuration.
5. Confirm docs match route behavior and status codes.
