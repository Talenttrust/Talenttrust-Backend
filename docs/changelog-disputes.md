# Disputes API Changelog

**Note:** This file should be updated for any future changes to the disputes API. Add a brief entry for each notable change and ensure the PR description references this changelog.

## 2026-07-27
- **Correlation ID Propagation** (`cde3e14`) - Added correlation ID propagation to disputes endpoints for distributed tracing. Correlation IDs are now threaded through request-scoped logs and echoed in response headers (X-Correlation-Id).

## 2026-07-26
- **Service Layer Refactoring** (`28f1dc5`) - Extracted business logic from disputes routes into a dedicated service layer (`src/services/disputes.service.ts`). Improves testability and separation of concerns.
- **Soft-Delete and Restore** (`19407d5`) - Added soft-delete functionality for disputes with restore capability. Soft-deleted disputes are retained for 30 days (configurable via `DISPUTES_SOFT_DELETE_RETENTION_DAYS`). Added endpoints: `DELETE /api/v1/disputes/:id` (soft-delete), `POST /api/v1/disputes/:id/restore` (restore).
- **Request Examples Documentation** (`2fa9949`) - Added comprehensive request/response examples to disputes documentation (`docs/disputes-examples.md`) for better developer experience.

## 2026-07-26
- **Feature Flag** (`cb6e449`) - Added feature flag support for disputes API. Disputes routes can be toggled via `features.disputesEnabled` configuration. Returns 404 when disabled.
- **Validation Schemas** (`fb93c53`) - Added Zod validation schemas for disputes operations (`src/routes/disputes.validation.ts`). Improves request validation and error messaging.
- **Metrics and Structured Logging** (`660c8c0`) - Added metrics collection and structured logging for disputes endpoints. Tracks request duration, status codes, and error rates for observability.
- **Edge-Case Regression Tests** (`6c18ee2`) - Added comprehensive edge-case regression tests for disputes routes to prevent regressions in boundary conditions.

## 2026-07-26
- **Event Webhook Callback** (`d9b3026`) - Added event webhook callback support for dispute lifecycle events. Disputes can trigger external webhooks on state changes.
- **Response Compression** (`8b5c4f8`) - Added automatic response compression for disputes endpoints. Responses above `DISPUTES_COMPRESSION_THRESHOLD` bytes are compressed using gzip/deflate.
- **Read Caching with Invalidation** (`14d0745`) - Added read caching layer for disputes GET operations with automatic cache invalidation on mutations. Improves performance for read-heavy workloads.

## 2026-07-25
- **Typed DTO Layer** (`bd928e7`) - Added typed Data Transfer Object layer for disputes (`src/modules/disputes/dto/dispute.dto.ts`). Improves type safety and API contract documentation.
- **Mutation Audit Log** (`b1ac1f6`) - Added audit logging for dispute mutations. All create, update, and delete operations are logged to the audit trail with actor, timestamp, and metadata.
- **Idempotency-Key Support** (`54950d9`) - Added idempotency-key support for dispute operations. Prevents duplicate processing of identical requests within the TTL window.
- **Bulk Disputes Endpoint** (`5dd52ec`) - Added bulk disputes endpoint (`PATCH /api/v1/disputes/batch`) for batch updates. Supports up to 50 items per batch with per-item validation and error reporting. See `BULK_DISPUTES_DESIGN.md` for details.
- **Rate Limiting** (`d9f675b`) - Added rate limiting to disputes endpoints using sensitive-tier configuration. Prevents abuse and accidental overload with 429 responses and Retry-After headers.

## 2026-07-25
- **Operations Runbook** (`5969780`) - Added comprehensive operations runbook (`docs/runbook-disputes.md`) for disputes API troubleshooting and maintenance.
- **Request Lifecycle Documentation** (`78d102a`) - Documented the disputes request lifecycle flow in `docs/disputes-flow.md`. Clarifies the sequence of operations from request to response.
- **API Contract Documentation** (`a00369a`) - Documented the disputes API contract in `docs/disputes.md`. Includes endpoint specifications, authentication, error codes, and examples.

*Please ensure each PR that modifies the disputes API includes an entry above with the date and a concise description.*
