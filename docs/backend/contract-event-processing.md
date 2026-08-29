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

## Contract Schema Versions

A contract's event payload shape can change when a newer contract version is
deployed on-chain. An event from a newer contract must not enter projections
that assume the older payload shape, but it must not be silently dropped
either:

- `schemaVersion` is optional on the event envelope. Absent = legacy
  (treated as version 1). Present-and-invalid is rejected at the boundary
  with 400 `invalid_event_payload` (fail-closed — an ambiguous version is
  never guessed).
- A valid-but-unknown version (newer than this backend supports) is
  **quarantined**: the redacted event is persisted to the
  `event_quarantine` store (`src/events/eventQuarantine.ts`) and the
  ingestion endpoint returns 202 `status: quarantined` with a quarantine
  id. Quarantined events never reach projections.
- `POST /api/v1/events/batch` ingests one RPC page with per-item
  isolation: a malformed or unknown-version event never blocks the rest of
  the page.
- `GET /api/v1/events/quarantine` (admin) lists quarantined events;
  `POST /api/v1/events/quarantine/replay` (admin, audited) reprocesses a
  quarantined event once support ships. A replay whose version is still
  unknown re-quarantines; replay attempts are bounded (no silent
  deletion).

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
