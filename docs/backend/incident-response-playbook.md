# Incident Response Playbook

This backend exposes responder-facing incident runbooks at `GET /api/v1/incident-response` and `GET /api/v1/incident-response/:runbookId`.

## Scope

- Outage triage
- Recovery execution
- Postmortem follow-up
- Security constraints during incident handling

## Runbooks

### `api-outage`

- Use for widespread API unavailability, elevated latency, or sustained 5xx errors.
- Prioritize blast-radius confirmation, rollback or failover, and a stable observation window before closing the incident.

### `data-integrity`

- Use for corruption, missing data, duplicated records, or reconciliation drift.
- Prioritize evidence preservation, write containment, verified restore paths, and dual-review for repair actions.

### `security-breach`

- Use for suspected compromise, unauthorized access, or credential exposure.
- Prioritize containment, credential rotation, rebuild from trusted images, and controlled communications.

## Security Notes

- Reject malformed runbook identifiers to avoid path-style abuse and undefined lookups.
- Keep incident artifacts and raw logs confidential because they may contain sensitive customer or operational data.
- Do not weaken authentication, rate limiting, or audit controls to speed up recovery.

## Review Guidance

- Runbook content is versioned with the backend so API clients and docs stay aligned.
- `lastReviewed` should be updated whenever runbook steps or security assumptions change.
- Add new runbooks through `src/incidentResponse.data.ts` and extend tests before exposing them.
