# Milestones API Changelog

All notable changes to the Milestones API are documented here. Milestones are
exposed through the Contracts API under `/api/v1/contracts`.

This file is scoped to `Talenttrust/Talenttrust-Backend` only. Any PR that
changes milestone endpoints, request or response shapes, validation or bounds,
feature flags, authentication requirements, soft-delete behaviour, or related
observable API behaviour must add a concise entry here and link this changelog
in the PR description.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## 2026-07-27

### Added

- Added milestone operation metrics and structured logging for contract create,
  update, and read operations. Metrics cover operation status, error cause, and
  duration without changing the request or response contract (`0fa531f`).

## 2026-07-26

### Added

- Added milestone soft-delete and restore endpoints:
  - `GET /api/v1/contracts/:id/milestones`
  - `POST /api/v1/contracts/:id/milestones`
  - `DELETE /api/v1/contracts/:id/milestones/:milestoneId`
  - `POST /api/v1/contracts/:id/milestones/:milestoneId/restore`
- Soft-deleted milestones are excluded from list responses by default and can
  be included with `includeDeleted=true`.
- Added the configurable `MILESTONES_SOFT_DELETE_RETENTION_DAYS` retention
  window, restore-expiry handling with `410 soft_delete_retention_expired`, and
  a purge entry point for expired records (`e5be7eb`).

- Added the `MILESTONES_ENABLED` runtime feature flag, enabled by default.
  When disabled, `milestones` fields on contract create and update requests are
  silently ignored without milestone validation (`97ab780`).

## 2026-07-25

### Changed

- Extracted milestone bounds and contract-budget validation into the
  `MilestonesService`, preserving the existing validation rules while making
  the logic reusable and independently testable (`a7f2860`).

## 2026-07-24

### Added

- Published the initial Milestones API contract documentation, covering the
  milestone object shape, validation and policy bounds, contract endpoints,
  error codes, authentication, permissions, idempotency, and optimistic
  concurrency control (`c8dad84`).
