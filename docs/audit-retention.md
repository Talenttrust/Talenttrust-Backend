# Audit Data Retention & Purge Policy

This document describes the data retention behavior of the Talenttrust audit subsystem.

## What is Stored

The audit log captures essential metadata for traceability and compliance. Each entry stores:
- **Core Identifiers:** Action type, severity, actor ID, resource type, and resource ID.
- **Network Data:** IP address.
- **Traceability:** Correlation IDs (e.g., from `requestId`).
- **Request Metadata:** HTTP method, path, HTTP headers, request body, and query parameters.
- **Cryptographic Chain:** A hash of the current entry and the `previous_hash` to ensure immutability (see `src/audit/sqliteRepository.ts`).

## PII Handling & Redaction

To protect Personally Identifiable Information (PII) and sensitive credentials, the audit subsystem employs strict deterministic redaction policies before any data is written to the database (see `src/audit/redact.ts`).

- **Fully Redacted Headers:** The `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, and `x-access-token` headers are completely suppressed and replaced with `[REDACTED]`.
- **Sensitive Keys:** Any JSON key in the request body, query parameters, or metadata containing substrings like `password`, `secret`, `token`, `credential`, `apikey`, `api_key`, or `private` is fully replaced with `[REDACTED]`.
- **Email Masking:** Email addresses found in the metadata are partially masked to balance PII protection with debuggability. The first three characters of the local part are retained, while the rest is masked (e.g., `alice@example.com` becomes `ali***@example.com`).

## Retention Window

**Infinite / Indefinite.**

Audit logs are retained permanently. The system does not enforce a time-to-live (TTL) or retention window on audit entries.

## Purge Behavior

There is **no automated purge** mechanism.

The audit log is implemented as an append-only, cryptographically verifiable ledger. Every new entry includes a hash of the previous entry's hash (forming a chain). Deleting, truncating, or purging any historical records would break the integrity chain, causing the `verifyIntegrity()` check in `SqliteAuditRepository` to fail.

Therefore, data cannot be safely purged from the audit log without invalidating the entire cryptographic chain from the point of deletion onwards. Any archival or log rotation strategy must be handled completely out-of-band and would require re-seeding a new genesis hash for the active database.
