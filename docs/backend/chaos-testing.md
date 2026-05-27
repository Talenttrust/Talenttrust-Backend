# Backend Chaos Testing for Dependencies

This backend supports controlled dependency outage simulation for resilience testing.

## Overview

Chaos testing is implemented around upstream dependency calls (currently contracts data retrieval). The API can intentionally simulate dependency errors/timeouts and verify graceful degradation behavior.

## Configuration

Set these environment variables:

- `GRACEFUL_DEGRADATION_ENABLED` (`true` or `false`, default `true`)
- `UPSTREAM_CONTRACTS_URL` (default `https://example.invalid/contracts`)
- `UPSTREAM_TIMEOUT_MS` (default `1200`, clamped to `100..10000`)
- `CHAOS_MODE` (`off`, `error`, `timeout`, `random`; default `off`)
- `CHAOS_TARGETS` (comma-separated dependency names, e.g. `contracts`)
- `CHAOS_PROBABILITY` (for `random`, float `0..1`)

## Expected API Behavior

Endpoint: `GET /api/v1/contracts`

- Normal path: `200` with `degraded: false` and `source: upstream`
- Dependency outage with graceful degradation enabled: `200` with empty contracts payload and `degraded: true`
- Dependency outage with graceful degradation disabled: `503` with `contracts_unavailable`

## Security Notes

- Failures are sanitized to avoid leaking upstream internals in API responses.
- Timeout value is clamped to prevent abuse from unsafe environment configuration.
- Fallback response is explicit (`degraded: true`) so downstream consumers can avoid treating it as fresh upstream data.
- Chaos controls are environment-driven and should remain disabled in production by setting `CHAOS_MODE=off`.

## Threat Scenarios Considered

- Upstream dependency becomes unreachable.
- Upstream returns malformed payloads.
- Upstream returns non-2xx status codes.
- Induced timeout/error injections to validate graceful degradation behavior.

## Testing Scope

- Unit tests validate chaos policy decisions and dependency client behavior.
- Integration tests validate API behavior for success, degraded fallback, and strict failure mode.
