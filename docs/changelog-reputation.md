# Reputation API Changelog

All notable changes to the Reputation API (`/api/v1/reputation/:id`) are documented here.

This file is scoped to `Talenttrust/Talenttrust-Backend` only. Any PR that changes
reputation request/response shape, scoring logic, validation rules, or auth
requirements for these endpoints **must** add an entry here in the same PR.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## 2026-07-25

### Added
- Documented the full reputation request lifecycle end-to-end, including
  middleware stack, auth checks, validation rules, anti-abuse guards, and the
  scoring algorithm (`docs/reputation-flow.md`). Closes #827.
- Rate limiting on reputation endpoints.
- Response contract tests and auth/tenant-scoping test coverage.
- Formal API contract documentation (#783).

### Changed
- Extracted a shared validation helper used across reputation handlers (#784).
- Replaced mock freelancer enumeration with a real data-backed query (#789).

## 2026-06-24 to 2026-06-27

### Added
- Recency-weighted (exponential decay) scoring algorithm for reputation scores.
- Snapshot/restore tests for the reputation checkpoint store.
- Exhaustive test coverage for anti-abuse guards (self-rating, duplicate
  review, contract-participation checks) and audit rollback behavior.

### Security
- Enforced strict rating range and integer-only validation in the reputation DTO.

### Fixed
- Reputation recompute background job now queries real freelancer IDs instead
  of a stubbed list.
- Environment validation now degrades gracefully in test environments.

## 2026-04-25 to 2026-04-27

### Added
- Checkpointed background job for recomputing reputation scores in bulk.
- JWT authentication + role-based access control (RBAC) on reputation endpoints.
- Persistence of reputation updates with a full audit trail.

## 2026-03-24

### Added
- Initial Reputation Profile API:
  - `GET /api/v1/reputation/:id` — retrieve a freelancer's reputation profile.
  - `PUT /api/v1/reputation/:id` — submit a review, recalculate the score.
  - 1–5 rating system with `score`, `jobsCompleted`, `totalRatings`.