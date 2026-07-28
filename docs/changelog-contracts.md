# Contracts API Changelog

**Note:** This file should be updated for any future changes to the contracts API. Add a brief entry for each notable change and ensure the PR description references this changelog.

## 2024-09-15
- Introduced **Contract Bounds** policy (`src/contracts/bounds.ts`) enforcing maximum milestones and budget limits. Updated API docs and added discovery endpoint `/api/v1/contracts/bounds`.

## 2024-08-30
- Implemented **Optimistic Concurrency Control** for contract updates using a version integer. Updated repository interface and error handling for version conflicts.

## 2024-07-20
- Added **Contract Lifecycle** documentation and sequence diagram (`docs/contracts-lifecycle.md`). Clarified state transitions and non‑fatal Soroban hand‑off handling.

## 2024-06-10
- Enabled **Graceful Degradation** for the contracts endpoint with environment variable `GRACEFUL_DEGRADATION_ENABLED`. Provides fallback payload on upstream failures.

## 2024-05-05
- Added **Contract Retrieval** endpoint (`GET /api/v1/contracts`) with upstream integration and caching layer.

*Please ensure each PR that modifies the contracts API includes an entry above with the date and a concise description.*
