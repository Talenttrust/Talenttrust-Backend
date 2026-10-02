# Audit API Changelog

**Note:** This file should be updated for any future changes to the audit API. Add a brief entry for each notable change and ensure the PR description references this changelog.

## 2026-07-27
- **Data Retention Documentation** (`4d3c01f`) - Documented audit data retention policy in `docs/audit-retention.md`. Clarified retention periods, archival processes, and compliance requirements for audit log data.

## 2026-07-26
- **Response Compression** (`cc52ab1`) - Added automatic response compression for audit endpoints. Responses above threshold are compressed using gzip/deflate to reduce bandwidth usage.
- **Validation Schemas** (`bfd0979`) - Added Zod validation schemas for audit operations (`src/audit/dto/audit.dto.ts`). Improves request validation and error messaging consistency.
- **Read Caching with Invalidation** (`074102f`) - Added read caching layer for audit GET operations with automatic cache invalidation on mutations. Improves performance for read-heavy audit queries.
- **Feature Flag** (`9cc17f6`) - Added `AUDIT_ENABLED` feature flag for audit subsystem. Audit routes can be toggled via configuration. Returns 404 when disabled.
- **LRU Eviction Test Fix** (`dd4fd3d`) - Fixed LRU eviction test timing consistency for audit cache. Ensures reliable test execution across different environments.

## 2026-07-25
- **Service Layer Extraction** (`7261089`) - Extracted business logic from audit routes into a dedicated service layer (`src/audit/service.ts`). Improves testability and separation of concerns.
- **Bulk Operations Endpoint** (`87487a2`) - Added bulk operations endpoint for audit (`POST /api/v1/audit/bulk`). Supports batch creation of audit entries with validation and error reporting.
- **Typed DTO Layer** (`9deeda8`) - Added typed Data Transfer Object layer for audit (`src/audit/dto/audit.dto.ts`). Improves type safety and API contract documentation.
- **Idempotency-Key Support** (`6ef5b73`) - Added idempotency-key support for audit write endpoints. Prevents duplicate processing of identical requests within the TTL window.
- **Request Validation and Bounds** (`07d71a5`) - Added comprehensive request validation and bounds checking for audit endpoints. Validates query parameters, limits, and offsets to prevent abuse.
- **Rate Limiting** (`fb39160`) - Added rate limiting to audit endpoints. Prevents abuse with configurable rate limits and 429 responses with Retry-After headers.
- **Cursor Pagination** (`ea906a1`) - Added cursor-based pagination to audit listing endpoint (`GET /api/v1/audit`). Improves performance for large datasets compared to offset-based pagination.
- **API Contract Documentation** (`f676fbe`) - Documented the audit API contract in `docs/audit.md`. Includes endpoint specifications, authentication, error codes, hash chain integrity, and redaction policy.

## 2026-07-24
- **Rate Limit Queue Depth Capping** (`53da5fb`) - Added per-provider queue depth capping with reject-on-overflow for rate limiter. Prevents memory exhaustion under high load.

## 2026-07-24
- **Shared Validation Helper** (`4181986`) - Extracted shared validation helper for audit operations. Reduces code duplication and improves consistency across audit endpoints.

## 2026-06-27
- **Export Service Tests** (`68851dd`) - Added comprehensive tests for audit export service including CSV-injection neutraliser. Ensures secure and reliable audit log exports.

## 2026-06-26
- **Streaming Audit Exports** (`9b9ea8f`) - Implemented streaming and filtering for audit exports to bound memory usage. Large exports no longer cause memory issues.
- **CSV Escaping and Format** (`ce7927b`) - Pinned audit CSV escaping, column order, and JSON export format. Ensures consistent output across different environments.
- **Audit Service and SQLite Repository Tests** (`1721e96`) - Added comprehensive test coverage for audit service and SQLite repository. Covers success and error paths.

## 2026-06-24
- **Deployment Audit Logging** (`330af36`) - Implemented real promotion, rollback, and promotion history with SQLite persistence and audit logging for deployment operations.
- **JWT Auth Migration** (`5b8227d`) - Migrated auth to verified JWT middleware and removed demo token backdoors. Improved security for audit endpoint access.
- **API Key and Audit Middleware Tests** (`3853a4f`) - Added unit test coverage for API key and audit middleware. Ensures proper authentication and authorization.

## 2026-04-28
- **Audit Log Export** (`4d735c2`) - Added audit log export with streaming and filters. Supports NDJSON and CSV formats for compliance downloads.

## 2026-04-25
- **Audit Repository Abstraction** (`a0df433`) - Added audit log repository abstraction with SQLite backend. Supports both in-memory and persistent storage configurations.

## 2026-04-23
- **Protected Endpoint Access with Redaction** (`42f025a`) - Implemented audit log for protected endpoint access with automatic redaction of sensitive data (headers, metadata keys, emails).

## 2026-03-23
- **Initial Audit Log Implementation** (`3cbd361`) - Implemented audit log system with tamper-evident hash chain, comprehensive tests, and documentation. Foundation for all audit functionality.

*Please ensure each PR that modifies the audit API includes an entry above with the date and a concise description.*
