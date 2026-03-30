# Request Tracing

## Overview

TalentTrust Backend includes lightweight request tracing that covers:

- API spans for each inbound Express request
- DB spans for contract repository operations
- RPC spans for Stellar RPC-facing operations

The implementation is intentionally dependency-light and uses `AsyncLocalStorage` so trace context flows through nested async work.

## Headers

Each response includes:

- `x-trace-id`
- `x-request-id`

If a caller provides either header, the middleware preserves it. Otherwise the backend generates one.

## Current span names

- `GET /health`
- `GET /api/v1/contracts`
- `contracts.repository.list`
- `contracts.rpc.fetch_registry_health`

## Security notes

- Trace payloads avoid request-body logging to reduce accidental leakage of secrets and PII.
- The middleware records only high-signal route and status metadata by default.
- Error capture stores message-level diagnostics only.

## Test coverage

Tracing behavior is covered by:

- `src/tracing/tracer.test.ts`
- `src/contracts/contracts.service.test.ts`
- `src/app.test.ts`
