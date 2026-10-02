---
type: Feature
title: "Persist the TransactionPoller's in-memory transactionsDb to SQLite for crash-safe polling"
labels: type:feature, area:transaction-poller, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Persist the TransactionPoller's in-memory transactionsDb to SQLite for crash-safe polling

### Description
`TransactionPoller.poll()` in [`src/services/TransactionPoller.ts`](src/services/TransactionPoller.ts) reads and writes transaction state through `transactionsDb`, an in-memory `Map`-backed store defined in [`src/models/Transaction.ts`](src/models/Transaction.ts). If the process restarts mid-poll, every `PENDING` transaction's `retryCount`, `lastCheckedAt`, and `receipt` are lost, so the poller silently abandons in-flight blockchain transactions and never reaches a terminal `SUCCESS`/`FAILED`/`TIMEOUT` state.

This issue replaces the in-memory store with a durable SQLite-backed implementation so polling survives restarts and resumes from the last persisted `retryCount`.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a SQLite-backed implementation of `TransactionsDbInterface` (the interface already declared in `Transaction.ts`) using the project's `better-sqlite3` helper in [`src/db/database.ts`](src/db/database.ts).
- Create a `transactions` table (hash PK, status, receipt JSON, last_checked_at, retry_count) via a migration in [`src/db/migrations.ts`](src/db/migrations.ts).
- On startup, the poller should rehydrate any non-terminal transactions and continue their backoff schedule using `calculateDelay` from [`src/utils/retry.ts`](src/utils/retry.ts).
- Keep the existing in-memory store available behind a feature flag for unit tests so test isolation is preserved.
- Preserve the existing `TransactionStatus` enum and `Transaction` shape; do not change the public poll API.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/transaction-poller-sqlite-persistence`
- Implement changes
  - **Write code in:** [`src/models/Transaction.ts`](src/models/Transaction.ts), [`src/services/TransactionPoller.ts`](src/services/TransactionPoller.ts), [`src/db/migrations.ts`](src/db/migrations.ts).
  - **Write comprehensive tests in:** [`src/services/TransactionPoller.test.ts`](src/services/TransactionPoller.test.ts) — assert state survives a simulated restart and that rehydrated transactions resume polling.
  - **Add documentation:** update [`README.md`](README.md) describing the transaction persistence model.
  - Include JSDoc on every new public method and the SQLite store class.
  - Validate security: ensure receipt JSON is parameter-bound (no string interpolation into SQL) and that malformed persisted receipts fail closed.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: restart with zero pending, restart mid-backoff, corrupted receipt row, and terminal-state rows that must not be re-polled.

### Example commit message
`feat: persist transaction poller state to SQLite with restart-safe rehydration`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Isolate per-channel failures in EscrowHooks so one failed notification channel does not drop the others"
labels: type:enhancement, area:notifications, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Isolate per-channel failures in EscrowHooks so one failed notification channel does not drop the others

### Description
`EscrowHooks.onEscrowEvent()` in [`src/hooks/escrow.hooks.ts`](src/hooks/escrow.hooks.ts) dispatches email and web notifications concurrently with `Promise.all`. Because `Promise.all` rejects as soon as any single channel throws, a transient failure in one channel (e.g. the email transport) aborts the whole dispatch and the other channel's notification is never confirmed — even though it may have succeeded or could have succeeded independently.

This issue switches the fan-out to `Promise.allSettled`, logs each channel's outcome, and surfaces an aggregated result so one bad channel can no longer silently suppress the rest.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace `Promise.all` with `Promise.allSettled` in `onEscrowEvent` and any sibling dispatch helpers in `escrow.hooks.ts`.
- Log per-channel success/failure through the structured logger in [`src/logger.ts`](src/logger.ts), including `contractId` and `userId` from the payload (never the raw email body).
- Return a typed `EscrowDispatchResult` summarizing which channels succeeded and which failed, so callers can decide on retry.
- Ensure a single channel exception cannot prevent the other channel from being attempted.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/escrow-hooks-channel-isolation`
- Implement changes
  - **Write code in:** [`src/hooks/escrow.hooks.ts`](src/hooks/escrow.hooks.ts), [`src/services/notification.service.ts`](src/services/notification.service.ts).
  - **Write comprehensive tests in:** [`src/hooks/escrow.hooks.test.ts`](src/hooks/escrow.hooks.test.ts) — assert that when the email channel rejects, the web channel is still attempted and the result reflects both outcomes.
  - **Add documentation:** document the dispatch semantics in [`src/modules/contractMetadata/README.md`](src/modules/contractMetadata/README.md) or a new `docs/notifications.md`.
  - Add JSDoc on the new result type and updated methods.
  - Validate security: confirm no PII (email body, addresses) leaks into logs.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: both channels fail, one fails, neither fails, and an empty/invalid payload.

### Example commit message
`feat: isolate per-channel escrow notification failures with allSettled`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Make ChaosPolicy randomness injectable so chaos tests are deterministic"
labels: type:refactor, area:chaos, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Make ChaosPolicy randomness injectable so chaos tests are deterministic

### Description
`ChaosPolicy.decide()` in [`src/chaos/chaosPolicy.ts`](src/chaos/chaosPolicy.ts) calls `Math.random()` directly when `chaosMode === 'random'`. This couples the policy to a global, non-seedable RNG, which makes the probabilistic branch impossible to test deterministically and impossible to reproduce when debugging a chaos-induced incident.

This issue injects the random source as a constructor dependency (defaulting to `Math.random`) so tests can supply a deterministic generator and reproduce exact decision sequences.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add an optional `random: () => number` parameter to the `ChaosPolicy` constructor, defaulting to `Math.random`.
- Use the injected function in the `'random'` branch of `decide()` without changing observable production behavior.
- Add boundary handling so `chaosProbability` of 0 never injects and 1 always injects.
- Keep the `ChaosResult` type and the `decide` signature unchanged for callers.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/chaos-policy-injectable-random`
- Implement changes
  - **Write code in:** [`src/chaos/chaosPolicy.ts`](src/chaos/chaosPolicy.ts).
  - **Write comprehensive tests in:** [`src/chaos/chaosPolicy.test.ts`](src/chaos/chaosPolicy.test.ts) — drive the `random` branch with a seeded stub and assert exact decision sequences plus the 0/1 probability boundaries.
  - **Add documentation:** document the injectable RNG and reproducibility note in JSDoc on `ChaosPolicy`.
  - Validate security: ensure chaos can never be active in production by default and is gated on `chaosMode`.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: untargeted dependency, each `chaosMode`, probability 0, probability 1, and case-insensitive target matching.

### Example commit message
`refactor: inject random source into ChaosPolicy for deterministic tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Enforce ServiceObjectives SLOs at runtime by evaluating recorded metrics against thresholds"
labels: type:feature, area:observability, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Enforce ServiceObjectives SLOs at runtime by evaluating recorded metrics against thresholds

### Description
[`src/operations/service-objectives.ts`](src/operations/service-objectives.ts) defines `ServiceObjective` targets (success rate, p95/p99 latency) per `OperationType`, but these are static declarations only — nothing in the running system compares observed metrics against them. The SLOs exist on paper but are never evaluated, so breaches go undetected.

This issue adds an evaluator that reads the live histograms/counters from the Prometheus registry in [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts) and reports per-objective compliance (meeting / breaching) so alerting and dashboards have a source of truth.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add an `evaluateObjectives(metrics)` function that maps each `ServiceObjective` to an observed success rate and p95/p99 latency.
- Source observations from the existing `MetricsService` registry rather than introducing a parallel metrics store.
- Return a structured compliance report (objective, observed vs target, breached boolean).
- Expose the report via a small read-only function the health/observability layer can call; do not wire a new public route in this issue.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/service-objectives-runtime-evaluation`
- Implement changes
  - **Write code in:** [`src/operations/service-objectives.ts`](src/operations/service-objectives.ts), [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts).
  - **Write comprehensive tests in:** [`src/operations/service-objectives.test.ts`](src/operations/service-objectives.test.ts) — feed synthetic metric values and assert correct breach/compliance classification at the thresholds.
  - **Add documentation:** document the SLO evaluation flow in [`README.md`](README.md).
  - Add JSDoc on the evaluator and report types.
  - Validate security: ensure the evaluator never throws on missing/empty metric series.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: exactly-at-threshold values, zero samples, and missing operation types.

### Example commit message
`feat: evaluate service objective SLOs against live Prometheus metrics`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Validate the generated OpenAPI spec in CI so docs cannot drift from Zod schemas"
labels: type:test, area:api-docs, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Validate the generated OpenAPI spec in CI so docs cannot drift from Zod schemas

### Description
[`src/docs/generate-openapi.ts`](src/docs/generate-openapi.ts) builds an OpenAPI 3.0 document from the Zod registry in [`src/docs/openapi-registry.ts`](src/docs/openapi-registry.ts), but nothing asserts the spec is well-formed or that every registered route schema actually produces a valid path. A broken or missing schema registration would only be discovered by a human reading the YAML.

This issue adds a test that generates the spec in-process and validates it (structure, required `info`/`paths`, and that known routes are present) so doc drift fails the build.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a test that calls `generateOpenApiSpec()` and asserts top-level `openapi`, `info`, `servers`, and a non-empty `paths` object.
- Assert that the contracts, reputation, and health routes registered in `generate-openapi.ts` appear as paths.
- Fail the test if any registered schema throws during generation.
- Do not write the YAML file from the test; validate the in-memory document only.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/openapi-spec-validation`
- Implement changes
  - **Write code in:** small testability tweak to [`src/docs/generate-openapi.ts`](src/docs/generate-openapi.ts) if needed to export the document builder cleanly.
  - **Write comprehensive tests in:** `src/docs/generate-openapi.test.ts` (new) — structural assertions on the generated spec.
  - **Add documentation:** document how to regenerate and validate the spec in [`README.md`](README.md).
  - Add JSDoc to any new exported helper.
  - Validate security: ensure no secrets or internal-only routes are emitted into the public spec.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty registry, a single route, and a deliberately malformed schema (expect a clear failure).

### Example commit message
`test: validate generated OpenAPI spec structure and registered paths`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a configurable max poll-duration ceiling to TransactionPoller to bound runaway backoff"
labels: type:enhancement, area:transaction-poller, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a configurable max poll-duration ceiling to TransactionPoller to bound runaway backoff

### Description
`TransactionPoller` in [`src/services/TransactionPoller.ts`](src/services/TransactionPoller.ts) caps polling by `maxRetries` only. With exponential backoff via `calculateDelay`, a high retry count can translate into an unbounded wall-clock duration before a transaction is marked `TIMEOUT`. There is no absolute time ceiling, so a single slow transaction can keep a poll alive far longer than intended.

This issue adds a configurable maximum total poll duration; once exceeded, the transaction is marked `TIMEOUT` regardless of remaining retries.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add an optional `maxTotalDurationMs` constructor parameter and track elapsed time across retries.
- When elapsed time exceeds the ceiling, transition the transaction to `TransactionStatus.TIMEOUT` and stop polling.
- Keep `maxRetries` behavior intact; the ceiling is an additional guard, whichever triggers first wins.
- Use an injectable clock so the duration logic is testable without real timers.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/transaction-poller-duration-ceiling`
- Implement changes
  - **Write code in:** [`src/services/TransactionPoller.ts`](src/services/TransactionPoller.ts), [`src/models/Transaction.ts`](src/models/Transaction.ts).
  - **Write comprehensive tests in:** [`src/services/TransactionPoller.test.ts`](src/services/TransactionPoller.test.ts) — use a fake clock to assert TIMEOUT fires on the duration ceiling before retries are exhausted.
  - **Add documentation:** document the ceiling and its interaction with `maxRetries` in JSDoc and [`README.md`](README.md).
  - Validate security: ensure the ceiling cannot be set to a value that disables timeouts silently.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: ceiling hit before first retry, ceiling never hit, and exactly-at-ceiling timing.

### Example commit message
`feat: add max total poll-duration ceiling to TransactionPoller`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Replace the in-memory contracts mock in ContractsService with the real ContractRepository everywhere"
labels: type:refactor, area:contracts, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Replace the in-memory contracts mock in ContractsService with the real ContractRepository everywhere

### Description
[`src/services/contracts.service.ts`](src/services/contracts.service.ts) still carries a `private contracts: any[] = []` in-memory mock and a deprecated `getAllContracts()` that returns it, alongside the repository-backed path. This dual code path is confusing, untyped (`any[]`), and risks callers reading stale mock data instead of the persisted contracts in [`src/repositories/contractRepository.ts`](src/repositories/contractRepository.ts).

This issue removes the in-memory mock entirely and routes every read/write through `ContractRepository`, restoring type safety.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Delete the `contracts: any[]` field and the deprecated mock-backed overload.
- Ensure all methods (`getAllContracts`, create/update, and cursor pagination) use `this.contractRepository` and the `Contract` type from [`src/db/types.ts`](src/db/types.ts).
- Keep `getContractsPage` cursor semantics intact (see [`src/contracts/cursor.types.ts`](src/contracts/cursor.types.ts)).
- Update any callers/controllers that relied on the deprecated method.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/contracts-service-remove-mock`
- Implement changes
  - **Write code in:** [`src/services/contracts.service.ts`](src/services/contracts.service.ts), [`src/controllers/contracts.controller.ts`](src/controllers/contracts.controller.ts).
  - **Write comprehensive tests in:** [`src/services/contracts.service.test.ts`](src/services/contracts.service.test.ts) — assert all reads/writes hit the repository with a mocked repository.
  - **Add documentation:** note the removal of the mock in JSDoc and [`README.md`](README.md).
  - Validate security: ensure bounds validation in [`src/contracts/bounds.ts`](src/contracts/bounds.ts) still runs on writes.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty repository, not-found contract, and bounds-violating create.

### Example commit message
`refactor: remove in-memory contracts mock and use ContractRepository exclusively`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a max-length and charset guard to decodeCursor before base64 decoding"
labels: type:security, area:pagination, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a max-length and charset guard to decodeCursor before base64 decoding

### Description
`decodeCursor()` in [`src/contracts/cursor.repository.ts`](src/contracts/cursor.repository.ts) accepts an opaque client-supplied cursor and immediately `Buffer.from(cursor, 'base64url')` + `JSON.parse`. An attacker can pass an arbitrarily large cursor string, forcing a large allocation and JSON parse before any validation runs. There is no upper bound on the cursor length or a charset pre-check.

This issue adds a cheap length and base64url-charset guard up front so oversized or malformed cursors are rejected with a 400 before any decode/parse work.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Reject cursors longer than a sane maximum (derive from `CURSOR_MAX_LIMIT`/expected payload size in [`src/contracts/cursor.types.ts`](src/contracts/cursor.types.ts)) before decoding.
- Validate the string is base64url before `Buffer.from`, throwing the same `Invalid pagination cursor` error already used.
- Preserve the existing opaque-cursor contract and the post-decode field validation.
- Keep the thrown error mapping to a 400 (not a 500).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/cursor-decode-length-guard`
- Implement changes
  - **Write code in:** [`src/contracts/cursor.repository.ts`](src/contracts/cursor.repository.ts).
  - **Write comprehensive tests in:** [`src/contracts/cursor.repository.test.ts`](src/contracts/cursor.repository.test.ts) — assert oversized and non-base64url cursors are rejected before parse, plus existing valid/invalid cases still pass.
  - **Add documentation:** document the cursor size bound in JSDoc on `decodeCursor`.
  - Validate security: confirm no unbounded allocation path remains.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty cursor, maximum-length valid cursor, one byte over the limit, and a non-base64url payload.

### Example commit message
`security: bound cursor length and charset before base64 decode`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add unit tests for the recency-weighted reputation decay math in computeWeightedReputationScore"
labels: type:test, area:reputation, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add unit tests for the recency-weighted reputation decay math in computeWeightedReputationScore

### Description
`computeWeightedReputationScore()` in [`src/services/reputation.service.ts`](src/services/reputation.service.ts) implements exponential time-decay weighting (`exp(-λ * ageInDays)`) with a fixed-clock `now` parameter for determinism. The decay math is the core of reputation scoring, yet it lacks focused unit tests for its numerical properties (monotonic decay, range preservation, empty input).

This issue adds rigorous, deterministic tests covering the decay function's mathematical guarantees independent of the surrounding service.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that an empty ratings array returns 0.
- Test that the result stays within the rating value range for in-range inputs.
- Test that a newer rating outweighs an older one with identical values (monotonic recency weighting).
- Test that larger λ decays older ratings faster, using fixed `now` and fixed `createdAt` values.
- Use exact tolerances for floating-point comparisons.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/reputation-decay-math`
- Implement changes
  - **Write code in:** no production change expected; export the function if needed for direct testing.
  - **Write comprehensive tests in:** [`src/services/reputation.service.test.ts`](src/services/reputation.service.test.ts) — add a dedicated describe block for the decay math.
  - **Add documentation:** note the tested invariants in JSDoc on the function.
  - Validate security: ensure no real DB or clock is touched in these unit tests.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: single rating, all-same-age ratings, and extreme λ values.

### Example commit message
`test: cover exponential decay math in computeWeightedReputationScore`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add scrypt password-hash and refresh-token rotation tests for AuthService"
labels: type:test, area:auth, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add scrypt password-hash and refresh-token rotation tests for AuthService

### Description
[`src/services/auth.service.ts`](src/services/auth.service.ts) hashes passwords with scrypt, compares secrets with `timingSafeEqual`, stores refresh tokens as SHA-256 hashes, and returns a uniform generic error to prevent user enumeration. These are security-critical behaviors that deserve explicit, dedicated coverage beyond happy-path login.

This issue adds tests asserting the hashing format, timing-safe comparison usage, refresh-token rotation, and the uniform error contract.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that registration produces a non-plaintext scrypt hash and that login verifies it.
- Test that refresh-token rotation issues a new token and invalidates the old hash.
- Test that a wrong password and a missing user return the same generic error message (no enumeration).
- Test that the raw refresh token is never persisted (only its SHA-256 hash).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/auth-service-hashing-and-rotation`
- Implement changes
  - **Write code in:** export internal helpers only if necessary for testability in [`src/services/auth.service.ts`](src/services/auth.service.ts).
  - **Write comprehensive tests in:** `src/services/auth.service.test.ts` (new) — use an in-memory better-sqlite3 instance.
  - **Add documentation:** cross-reference the security notes block already in `auth.service.ts`.
  - Validate security: tests must not log raw tokens or passwords.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: duplicate registration, expired refresh token, and reused (already-rotated) refresh token.

### Example commit message
`test: cover scrypt hashing and refresh-token rotation in AuthService`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add JWT expiry, signature, and malformed-token tests for the requireAuth path"
labels: type:test, area:auth, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add JWT expiry, signature, and malformed-token tests for the requireAuth path

### Description
[`src/services/auth.service.ts`](src/services/auth.service.ts) issues HS256 JWTs with a 15-minute access TTL and a defined `TokenPayload` shape consumed by `requireAuth` in [`src/auth/authenticate.ts`](src/auth/authenticate.ts). The verification path needs explicit negative tests: expired tokens, tampered signatures, wrong-algorithm tokens, and payloads missing required claims.

This issue adds focused tests so authentication rejects every malformed or expired token class.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that an expired access token is rejected.
- Test that a token signed with a different secret is rejected.
- Test that a token with a missing `sub`/`role` claim is rejected.
- Test that an `alg: none` or non-HS256 token is rejected (algorithm confusion guard).
- Use fixed clocks where the library supports it for deterministic expiry tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/jwt-requireauth-negative-cases`
- Implement changes
  - **Write code in:** small hardening in [`src/auth/authenticate.ts`](src/auth/authenticate.ts) if an algorithm allowlist is missing.
  - **Write comprehensive tests in:** `src/auth/authenticate.test.ts` (new).
  - **Add documentation:** note the accepted algorithm and required claims in JSDoc.
  - Validate security: ensure the verifier pins HS256 and never accepts `none`.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: missing Authorization header, malformed Bearer prefix, and empty token.

### Example commit message
`test: cover JWT expiry, signature, and algorithm-confusion rejection in requireAuth`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Pin the JWT verification algorithm to HS256 to prevent algorithm-confusion attacks"
labels: type:security, area:auth, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Pin the JWT verification algorithm to HS256 to prevent algorithm-confusion attacks

### Description
[`src/services/auth.service.ts`](src/services/auth.service.ts) signs JWTs with HS256, and `requireAuth` in [`src/auth/authenticate.ts`](src/auth/authenticate.ts) verifies them. If `jwt.verify` is called without an explicit `algorithms` allowlist, the library will accept any algorithm encoded in the token header, opening the door to `alg: none` and HS/RS confusion attacks.

This issue pins verification to `['HS256']` explicitly and rejects every other algorithm.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Pass `{ algorithms: ['HS256'] }` to every `jwt.verify` call on the auth path.
- Reject tokens whose header algorithm is not HS256 with the standard 401 path.
- Centralize the verify options so future token consumers cannot accidentally omit the allowlist.
- Do not change token issuance behavior.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/jwt-pin-hs256-algorithm`
- Implement changes
  - **Write code in:** [`src/auth/authenticate.ts`](src/auth/authenticate.ts), [`src/services/auth.service.ts`](src/services/auth.service.ts).
  - **Write comprehensive tests in:** `src/auth/authenticate.test.ts` — assert `none` and non-HS256 tokens are rejected even with an otherwise valid payload.
  - **Add documentation:** document the algorithm pin in the security notes of `auth.service.ts`.
  - Validate security: confirm no verify call path omits the allowlist.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: `alg: none`, RS256-headered token, and a valid HS256 token.

### Example commit message
`security: pin JWT verification to HS256 algorithm allowlist`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add cursor-pagination integration tests for the contract indexer replay guarantees"
labels: type:test, area:contracts, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add cursor-pagination integration tests for the contract indexer replay guarantees

### Description
[`src/contracts/indexer.ts`](src/contracts/indexer.ts) is a replay-safe event indexer with cursor checkpointing that reports `processedCount`, `duplicateCount`, and `errors` per batch. Its replay-protection guarantee — re-indexing the same batch yields zero new processed events — is core to correctness but lacks an end-to-end test that drives the cursor across batches.

This issue adds integration tests exercising the full index → checkpoint → replay flow against the cursor repository.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Index a batch, assert `processedCount` and the returned `newCursor`.
- Re-index the same batch and assert `duplicateCount` equals the batch size and `processedCount` is 0.
- Index a partially-overlapping next batch and assert only new events are processed.
- Use the real [`src/contracts/cursor.repository.ts`](src/contracts/cursor.repository.ts) and processor wiring rather than mocks where feasible.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/contract-indexer-replay-integration`
- Implement changes
  - **Write code in:** no production change expected.
  - **Write comprehensive tests in:** `src/contracts/indexer.integration.test.ts` (new), complementing [`src/contracts/indexer.test.ts`](src/contracts/indexer.test.ts).
  - **Add documentation:** note the replay invariants under test in JSDoc on `indexBatch`.
  - Validate security: ensure malformed events surface in `errors` without aborting the batch.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty batch, all-duplicate batch, and a batch with one failing event.

### Example commit message
`test: add replay-safety integration tests for the contract indexer`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Emit reputation-recompute duration and rating-count metrics to the Prometheus registry"
labels: type:feature, area:observability, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Emit reputation-recompute duration and rating-count metrics to the Prometheus registry

### Description
The reputation scoring pipeline in [`src/services/reputation.service.ts`](src/services/reputation.service.ts) and its scheduler in [`src/services/reputation-scheduler.service.ts`](src/services/reputation-scheduler.service.ts) run periodic recomputations, but emit no metrics. There is no visibility into how long a recompute takes or how many ratings it processed, so regressions and pile-ups are invisible on dashboards.

This issue adds histogram and counter metrics through the existing `MetricsService` registry in [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts).

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a histogram for recompute duration and a counter for ratings processed per run.
- Register these on the existing Prometheus `Registry` so they appear on the metrics endpoint.
- Record values from the scheduler's recompute loop without changing scoring results.
- Avoid high-cardinality labels (no per-user labels).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/reputation-recompute-metrics`
- Implement changes
  - **Write code in:** [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts), [`src/services/reputation-scheduler.service.ts`](src/services/reputation-scheduler.service.ts).
  - **Write comprehensive tests in:** [`src/observability/metrics-service.test.ts`](src/observability/metrics-service.test.ts) and [`src/services/reputation-scheduler.service.test.ts`](src/services/reputation-scheduler.service.test.ts).
  - **Add documentation:** list the new metric names in [`README.md`](README.md).
  - Add JSDoc on the new metric accessors.
  - Validate security: confirm metric labels carry no PII.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: zero ratings, a failed recompute run, and concurrent runs.

### Example commit message
`feat: emit reputation recompute duration and count metrics`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a retry-with-backoff wrapper around SorobanRpcService outbound RPC calls"
labels: type:enhancement, area:soroban-rpc, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a retry-with-backoff wrapper around SorobanRpcService outbound RPC calls

### Description
[`src/services/soroban/SorobanRpcService.ts`](src/services/soroban/SorobanRpcService.ts) issues RPC calls to the Stellar/Soroban network. Transient network blips and 5xx responses currently propagate immediately to callers, even though the project already has a tested backoff helper in [`src/utils/retry.ts`](src/utils/retry.ts). A single transient failure becomes a user-visible error.

This issue wraps idempotent read RPC calls in the existing retry helper with jittered exponential backoff and a bounded attempt count.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Wrap only idempotent reads (e.g. getting transaction/ledger status) in the retry helper; never auto-retry submission of mutating transactions blindly.
- Reuse `calculateDelay`/retry primitives from [`src/utils/retry.ts`](src/utils/retry.ts).
- Make attempt count and base delay configurable through the existing config layer.
- Surface a clear final error after retries are exhausted.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/soroban-rpc-retry-backoff`
- Implement changes
  - **Write code in:** [`src/services/soroban/SorobanRpcService.ts`](src/services/soroban/SorobanRpcService.ts).
  - **Write comprehensive tests in:** [`src/services/soroban/__tests__/SorobanRpcService.test.ts`](src/services/soroban/__tests__/SorobanRpcService.test.ts) — assert retries on transient errors and no retry on non-idempotent paths.
  - **Add documentation:** document retried vs non-retried calls in JSDoc and [`README.md`](README.md).
  - Validate security: ensure no double-submission of mutating transactions.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: success on first try, success after N retries, exhausted retries, and a non-retryable error.

### Example commit message
`feat: add jittered retry/backoff to idempotent Soroban RPC reads`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add pagination and filtering to the audit export service to bound memory on large exports"
labels: type:enhancement, area:audit, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add pagination and filtering to the audit export service to bound memory on large exports

### Description
[`src/audit/exportService.ts`](src/audit/exportService.ts) materializes audit records for CSV/JSON export. As the audit log grows, an unbounded full-table export loads every row into memory at once, risking OOM and long-blocking responses. There is no date-range filter or streaming/chunked output.

This issue adds date-range and event-type filtering plus chunked streaming so large exports stay memory-bounded.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add optional `from`/`to` timestamp and event-type filters to the export query against [`src/audit/sqliteRepository.ts`](src/audit/sqliteRepository.ts).
- Stream rows in batches rather than buffering the entire result set.
- Preserve the existing CSV and JSON output formats and column ordering.
- Continue redacting sensitive fields via [`src/audit/redact.ts`](src/audit/redact.ts) on the streamed path.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/audit-export-pagination-streaming`
- Implement changes
  - **Write code in:** [`src/audit/exportService.ts`](src/audit/exportService.ts), [`src/audit/sqliteRepository.ts`](src/audit/sqliteRepository.ts).
  - **Write comprehensive tests in:** [`src/audit/exportService.test.ts`](src/audit/exportService.test.ts) — assert filtering, batch boundaries, and redaction on streamed output.
  - **Add documentation:** document export filters in [`README.md`](README.md).
  - Add JSDoc on the new streaming export method.
  - Validate security: redaction must still apply per row.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty range, range with no rows, and a batch boundary that splits the last chunk.

### Example commit message
`feat: stream and filter audit exports to bound memory`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Enforce a maximum page-size cap in the pagination utility to prevent large-limit abuse"
labels: type:security, area:pagination, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Enforce a maximum page-size cap in the pagination utility to prevent large-limit abuse

### Description
[`src/utils/pagination.ts`](src/utils/pagination.ts) parses page/limit query parameters for list endpoints. Without a hard upper bound on `limit`, a client can request an enormous page size and force the backend to read and serialize a huge result set in a single request, a denial-of-service amplification vector.

This issue clamps the effective limit to a configurable maximum and documents the cap in the response metadata.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Clamp parsed `limit` to a configurable `MAX_PAGE_SIZE` (with a sane default).
- Coerce non-numeric / negative / zero limits to the default safely.
- Reflect the applied (possibly clamped) limit in the pagination metadata so clients can detect the cap.
- Keep the existing pagination response shape and helpers in [`src/utils/sorting.ts`](src/utils/sorting.ts)/[`src/utils/filtering.ts`](src/utils/filtering.ts) compatible.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/pagination-max-page-size`
- Implement changes
  - **Write code in:** [`src/utils/pagination.ts`](src/utils/pagination.ts).
  - **Write comprehensive tests in:** [`src/utils/pagination.test.ts`](src/utils/pagination.test.ts) — assert clamping at, above, and below the cap, plus invalid inputs.
  - **Add documentation:** document the cap and default in JSDoc and [`README.md`](README.md).
  - Validate security: confirm no path bypasses the clamp.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: limit just above cap, negative limit, NaN limit, and missing limit.

### Example commit message
`security: clamp pagination limit to a configurable maximum`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a parameterized allowlist for sort fields to prevent SQL/sort-key injection in sorting utility"
labels: type:security, area:query-utils, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a parameterized allowlist for sort fields to prevent SQL/sort-key injection in sorting utility

### Description
[`src/utils/sorting.ts`](src/utils/sorting.ts) translates a client-supplied `sortBy`/`order` into a sort directive for list endpoints. If the field name is passed through to a query without an allowlist, a caller can sort by an arbitrary or non-existent column, leaking schema details or causing errors — and in repositories that interpolate the column, a potential injection.

This issue requires each caller to declare an allowlist of sortable columns and rejects any field outside it.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add an `allowedFields` parameter to the sort parser; reject or default any field not in the list.
- Normalize `order` strictly to `asc`/`desc`.
- Ensure repositories (e.g. [`src/repositories/contractRepository.ts`](src/repositories/contractRepository.ts)) consume only validated column names.
- Keep the public sort response/metadata shape unchanged.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/sorting-field-allowlist`
- Implement changes
  - **Write code in:** [`src/utils/sorting.ts`](src/utils/sorting.ts).
  - **Write comprehensive tests in:** [`src/utils/sorting.test.ts`](src/utils/sorting.test.ts) — assert disallowed fields are rejected/defaulted and order normalization.
  - **Add documentation:** document the allowlist contract in JSDoc.
  - Validate security: confirm no unvalidated field name can reach a query.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: unknown field, empty allowlist, uppercase order, and an injection-style field string.

### Example commit message
`security: require a sort-field allowlist to block sort-key injection`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add request-context AsyncLocalStorage so correlation IDs flow into logs without manual passing"
labels: type:enhancement, area:observability, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add request-context AsyncLocalStorage so correlation IDs flow into logs without manual passing

### Description
[`src/middleware/requestContext.ts`](src/middleware/requestContext.ts) and [`src/middleware/requestId.ts`](src/middleware/requestId.ts) attach a correlation/request id to the request, but downstream services and the logger in [`src/logger.ts`](src/logger.ts) must receive it explicitly. Deep call chains often drop the id, so logs from services and queue processors lose correlation.

This issue introduces an `AsyncLocalStorage`-backed request context so any code can read the current correlation id from anywhere in the async call tree.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Establish an `AsyncLocalStorage` store seeded by the request-context middleware with the correlation id.
- Add a logger binding that automatically includes the current correlation id from the store.
- Ensure the store is correctly propagated across `await` boundaries and does not leak between requests.
- Provide a safe default (no id) when running outside a request (e.g. scheduled jobs).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/request-context-async-local-storage`
- Implement changes
  - **Write code in:** [`src/middleware/requestContext.ts`](src/middleware/requestContext.ts), [`src/logger.ts`](src/logger.ts).
  - **Write comprehensive tests in:** [`src/middleware/requestContext`](src/middleware/) test file and a logger test asserting the id appears and does not bleed across concurrent requests.
  - **Add documentation:** document the context propagation model in [`README.md`](README.md).
  - Add JSDoc on the store accessor.
  - Validate security: ensure no cross-request context leakage under concurrency.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: concurrent requests, nested awaits, and code running with no active context.

### Example commit message
`feat: propagate correlation id via AsyncLocalStorage request context`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add unit tests for the contract bounds validator covering milestone and amount limits"
labels: type:test, area:contracts, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add unit tests for the contract bounds validator covering milestone and amount limits

### Description
[`src/contracts/bounds.ts`](src/contracts/bounds.ts) enforces `MAX_MILESTONES_PER_CONTRACT` and `MAX_CONTRACT_AMOUNT_STROOPS` via `validateContractBounds`, throwing `ContractBoundsError` on violation. These limits protect the escrow flow from oversized contracts, but the boundary behavior (exactly at limit vs one over) needs explicit, dedicated coverage.

This issue adds focused tests for every bound and its exact threshold.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that a contract at exactly the milestone/amount limit is accepted.
- Test that one milestone over and one stroop over the amount limit throw `ContractBoundsError`.
- Test zero/negative amounts and zero milestones behavior.
- Assert the thrown error type and message clarity.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/contract-bounds-validation`
- Implement changes
  - **Write code in:** no production change expected.
  - **Write comprehensive tests in:** [`src/contracts/bounds.test.ts`](src/contracts/bounds.test.ts) — extend with boundary cases.
  - **Add documentation:** reference the tested limits in JSDoc on `validateContractBounds`.
  - Validate security: confirm overflow-safe comparison for stroop amounts.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: max milestones exactly, max amount exactly, and over-limit by one.

### Example commit message
`test: cover milestone and amount boundary cases in contract bounds validator`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add idempotency-store TTL eviction and tests in db/idempotencyStore"
labels: type:enhancement, area:idempotency, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add idempotency-store TTL eviction and tests in db/idempotencyStore

### Description
[`src/db/idempotencyStore.ts`](src/db/idempotencyStore.ts) records idempotency keys for request de-duplication, but without a TTL/expiry sweep the store grows without bound and old keys are never reclaimed. Over time this inflates storage and can slow lookups.

This issue adds a configurable TTL and an eviction sweep so expired idempotency keys are purged.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Store a `createdAt`/`expiresAt` per key and add a `purgeExpired(now)` method.
- Make the TTL configurable through the config layer in [`src/config`](src/config/).
- Treat an expired key as absent on lookup so a re-submission after TTL is processed fresh.
- Keep the store interface used by [`src/middleware/idempotency.ts`](src/middleware/idempotency.ts) backward compatible.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/idempotency-store-ttl-eviction`
- Implement changes
  - **Write code in:** [`src/db/idempotencyStore.ts`](src/db/idempotencyStore.ts).
  - **Write comprehensive tests in:** `src/db/idempotencyStore.test.ts` (new) — assert expired keys are purged and treated as absent with an injected clock.
  - **Add documentation:** document the TTL behavior in JSDoc and [`README.md`](README.md).
  - Validate security: ensure purge is parameter-bound and cannot delete unexpired keys.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: key exactly at expiry, purge with no expired keys, and re-submit after expiry.

### Example commit message
`feat: add TTL eviction to the idempotency store`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add per-job timeout and abort handling to the queue manager to prevent stuck jobs"
labels: type:enhancement, area:queue, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add per-job timeout and abort handling to the queue manager to prevent stuck jobs

### Description
[`src/queue/queue-manager.ts`](src/queue/queue-manager.ts) dispatches jobs to processors but has no per-job execution timeout. A processor that hangs (e.g. a stalled RPC or email transport) can occupy a worker slot indefinitely, starving the queue and blocking retries. There is no abort signal threaded into processors.

This issue adds a configurable per-job timeout that aborts a hung job and routes it to the retry/DLQ path.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a configurable per-job timeout (overridable per job type) in [`src/queue/config.ts`](src/queue/config.ts).
- Pass an `AbortSignal` into processors so cooperative cancellation is possible.
- On timeout, treat the job as failed and hand it to the existing retry-manager/DLQ flow in [`src/queue/retry-manager.ts`](src/queue/retry-manager.ts).
- Do not break processors that ignore the signal; the wall-clock timeout still applies.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/queue-per-job-timeout`
- Implement changes
  - **Write code in:** [`src/queue/queue-manager.ts`](src/queue/queue-manager.ts), [`src/queue/config.ts`](src/queue/config.ts).
  - **Write comprehensive tests in:** [`src/queue/queue-manager.test.ts`](src/queue/queue-manager.test.ts) — assert a hanging job times out and is retried/DLQ'd.
  - **Add documentation:** document timeouts in [`README.md`](README.md).
  - Add JSDoc on the timeout configuration.
  - Validate security: ensure timed-out jobs cannot double-execute.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: job finishing just before timeout, job exceeding timeout, and a processor honoring the abort signal.

### Example commit message
`feat: add per-job timeout and abort signal to the queue manager`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a contractMetadata caching layer with SWR to cut redundant repository reads"
labels: type:enhancement, area:contract-metadata, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a contractMetadata caching layer with SWR to cut redundant repository reads

### Description
[`src/modules/contractMetadata/contractMetadata.service.ts`](src/modules/contractMetadata/contractMetadata.service.ts) reads contract metadata from [`src/modules/contractMetadata/contractMetadata.repository.ts`](src/modules/contractMetadata/contractMetadata.repository.ts) on every request. Hot contracts are read repeatedly, hammering the store. The project already ships a stale-while-revalidate cache in [`src/utils/swrCache.ts`](src/utils/swrCache.ts) that is unused here.

This issue wraps metadata reads in the SWR cache so hot lookups are served from cache and revalidated in the background.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Cache reads keyed by contract id using the existing `swrCache` utility.
- Invalidate or bypass the cache on writes/updates so stale metadata is not served after an edit.
- Make TTL/stale window configurable through [`src/config`](src/config/).
- Preserve the service's public API and existing hash-verification behavior in [`src/contractMetadata.ts`](src/contractMetadata.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/contract-metadata-swr-cache`
- Implement changes
  - **Write code in:** [`src/modules/contractMetadata/contractMetadata.service.ts`](src/modules/contractMetadata/contractMetadata.service.ts).
  - **Write comprehensive tests in:** [`src/modules/contractMetadata/contractMetadata.test.ts`](src/modules/contractMetadata/contractMetadata.test.ts) — assert cache hits, background revalidation, and invalidation on write.
  - **Add documentation:** update [`src/modules/contractMetadata/README.md`](src/modules/contractMetadata/README.md).
  - Add JSDoc on the caching wrapper.
  - Validate security: ensure cache keys cannot collide across tenants/contracts.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: cache miss, stale-served-then-revalidated, and post-write invalidation.

### Example commit message
`feat: cache contract metadata reads with stale-while-revalidate`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add tests for the dependency-policy evaluation against npm-audit severity thresholds"
labels: type:test, area:dependency-scanning, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add tests for the dependency-policy evaluation against npm-audit severity thresholds

### Description
[`src/security/dependency-policy.ts`](src/security/dependency-policy.ts) decides whether a dependency scan passes or fails based on severity thresholds, consuming parsed output from [`src/security/npm-audit-parser.ts`](src/security/npm-audit-parser.ts). The pass/fail gate is security-critical (it can block a release), but the threshold boundary logic needs explicit coverage.

This issue adds tests that drive the policy with synthetic audit findings across every severity level.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that findings below the configured threshold pass and at/above fail.
- Test mixed-severity inputs resolve to the highest-severity decision.
- Test empty findings (clean scan) passes.
- Use fixtures resembling real npm-audit JSON shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/dependency-policy-thresholds`
- Implement changes
  - **Write code in:** no production change expected.
  - **Write comprehensive tests in:** [`src/security/dependency-policy.test.ts`](src/security/dependency-policy.test.ts) — extend with threshold boundary cases.
  - **Add documentation:** reference the policy thresholds in JSDoc.
  - Validate security: ensure the gate fails closed on unrecognized severity labels.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: exactly-at-threshold, one above, clean scan, and unknown severity.

### Example commit message
`test: cover dependency-policy severity threshold decisions`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Validate reputation rating values against an allowed range in the reputation DTO schema"
labels: type:security, area:reputation, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Validate reputation rating values against an allowed range in the reputation DTO schema

### Description
The reputation flow feeds rating values into [`src/services/reputation.service.ts`](src/services/reputation.service.ts), whose decay math only guarantees range preservation when inputs are themselves in range. The request DTO in [`src/modules/reputation/dto/reputation.dto.ts`](src/modules/reputation/dto/reputation.dto.ts) should reject out-of-range or non-integer ratings at the boundary, before they pollute the score.

This issue tightens the Zod DTO to enforce the rating range and integrality.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Constrain the rating field to the allowed numeric range (e.g. min/max) and require an integer.
- Reject NaN/infinite/over-range values with a clear validation error via the existing validation middleware.
- Keep the DTO compatible with the OpenAPI registration in [`src/docs/openapi-registry.ts`](src/docs/openapi-registry.ts).
- Ensure the controller in [`src/controllers/reputation.controller.ts`](src/controllers/reputation.controller.ts) surfaces a 400 on violation.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/reputation-rating-range-validation`
- Implement changes
  - **Write code in:** [`src/modules/reputation/dto/reputation.dto.ts`](src/modules/reputation/dto/reputation.dto.ts).
  - **Write comprehensive tests in:** [`src/controllers/reputation.controller.test.ts`](src/controllers/reputation.controller.test.ts) — assert out-of-range and non-integer ratings are rejected.
  - **Add documentation:** note the rating constraints in JSDoc and OpenAPI description.
  - Validate security: confirm no out-of-range rating can reach the score computation.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: min, max, min-1, max+1, decimal, and NaN.

### Example commit message
`security: enforce rating range and integrality in reputation DTO`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add unit tests for the reputation checkpoint store snapshot and restore"
labels: type:test, area:reputation, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add unit tests for the reputation checkpoint store snapshot and restore

### Description
[`src/models/reputation-checkpoint.store.ts`](src/models/reputation-checkpoint.store.ts) persists reputation checkpoints used to resume or roll back recomputation. The snapshot/restore semantics are central to recovery but warrant dedicated, isolated tests beyond what the surrounding services cover.

This issue adds focused tests for writing, reading, overwriting, and restoring checkpoints.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that a written checkpoint reads back identically.
- Test that overwriting a checkpoint replaces the prior snapshot.
- Test restore behavior when no checkpoint exists.
- Test that concurrent writes resolve to a consistent final state.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/reputation-checkpoint-store`
- Implement changes
  - **Write code in:** no production change expected.
  - **Write comprehensive tests in:** [`src/models/reputation-checkpoint.store.test.ts`](src/models/reputation-checkpoint.store.test.ts) — extend with snapshot/restore edge cases.
  - **Add documentation:** reference checkpoint semantics in JSDoc.
  - Validate security: ensure serialized checkpoints contain no secrets.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty store, overwrite, missing checkpoint restore, and concurrent writes.

### Example commit message
`test: cover reputation checkpoint store snapshot and restore`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add structured request/response logging redaction for Authorization and Cookie headers"
labels: type:security, area:logging, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add structured request/response logging redaction for Authorization and Cookie headers

### Description
The HTTP logger in [`src/middleware/httpLogger.ts`](src/middleware/httpLogger.ts) (and [`src/middleware/requestLogger.ts`](src/middleware/requestLogger.ts)) records request metadata. If it logs headers without redaction, `Authorization` bearer tokens and `Cookie` session values can land in logs verbatim, a serious credential-leak risk. The project has a redaction helper in [`src/utils/redact.ts`](src/utils/redact.ts) that should be applied here.

This issue ensures sensitive headers are redacted before any request/response log line is emitted.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Redact `Authorization`, `Cookie`, `Set-Cookie`, and known API-key headers before logging.
- Reuse [`src/utils/redact.ts`](src/utils/redact.ts) rather than introducing a new redaction list.
- Apply redaction on both request and response logging paths.
- Keep non-sensitive metadata (method, path, status, latency, correlation id) intact.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/http-logger-header-redaction`
- Implement changes
  - **Write code in:** [`src/middleware/httpLogger.ts`](src/middleware/httpLogger.ts), [`src/middleware/requestLogger.ts`](src/middleware/requestLogger.ts).
  - **Write comprehensive tests in:** [`src/middleware/httpLogger.test.ts`](src/middleware/httpLogger.test.ts) — assert sensitive headers never appear in emitted log lines.
  - **Add documentation:** document logged vs redacted fields in [`README.md`](README.md).
  - Validate security: confirm tokens/cookies are masked in all branches.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: missing headers, multiple cookies, and case-insensitive header names.

### Example commit message
`security: redact Authorization and Cookie headers in HTTP logging`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a configurable CORS allowlist driven by environment config in the Express app"
labels: type:security, area:http, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a configurable CORS allowlist driven by environment config in the Express app

### Description
The Express application assembled in [`src/app.ts`](src/app.ts) serves the API but does not have an explicit, environment-driven CORS allowlist tied to [`src/config/env.schema.ts`](src/config/env.schema.ts). A permissive or implicit CORS posture allows untrusted origins to call authenticated endpoints from the browser.

This issue adds a strict, configurable CORS allowlist sourced from validated environment configuration.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Read an allowed-origins list from validated env config (comma-separated), defaulting to deny-by-default in production.
- Reflect only allowlisted origins; reject others without echoing arbitrary origins.
- Configure allowed methods/headers explicitly and support credentials only when an origin is allowlisted.
- Keep local dev convenient (e.g. localhost) without weakening production.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/cors-allowlist-from-env`
- Implement changes
  - **Write code in:** [`src/app.ts`](src/app.ts), [`src/config/env.schema.ts`](src/config/env.schema.ts).
  - **Write comprehensive tests in:** [`src/app.integration.test.ts`](src/app.integration.test.ts) — assert allowlisted origins succeed and others are rejected.
  - **Add documentation:** document the CORS env vars in [`README.md`](README.md).
  - Validate security: confirm no wildcard origin with credentials.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: allowlisted origin, disallowed origin, no Origin header, and preflight OPTIONS.

### Example commit message
`security: add env-driven CORS allowlist to the Express app`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Document the authentication and refresh-token rotation flow in an AUTH.md runbook"
labels: type:docs, area:auth, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Document the authentication and refresh-token rotation flow in an AUTH.md runbook

### Description
The authentication design in [`src/services/auth.service.ts`](src/services/auth.service.ts) — scrypt hashing, HS256 access tokens, SHA-256-hashed refresh tokens, rotation, and uniform error responses — is only described in inline comments. New contributors and integrators have no single document explaining the token lifecycle, TTLs, and rotation semantics.

This issue adds a dedicated `AUTH.md` runbook covering registration, login, refresh rotation, and revocation.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Document the full lifecycle: register → login → access token (15m) → refresh (7d) → rotation.
- Document the security properties: timing-safe comparisons, hashed refresh storage, and enumeration-safe errors.
- Include a sequence diagram for refresh-token rotation.
- Cross-reference [`src/auth/authenticate.ts`](src/auth/authenticate.ts) and the auth routes in [`src/routes/auth.routes.ts`](src/routes/auth.routes.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/auth-runbook`
- Implement changes
  - **Write code in:** no production change; documentation only.
  - **Write comprehensive tests in:** N/A — verify any referenced code paths exist and links resolve.
  - **Add documentation:** create `AUTH.md` at the repo root and link it from [`README.md`](README.md).
  - Validate security: ensure no real secrets/tokens are embedded in examples.
- Test and commit

### Test and commit
- Run `npm run lint` (and `npm test` if doc snippets are executed).
- Verify all file links resolve and examples are accurate.

### Example commit message
`docs: add AUTH.md runbook for token lifecycle and rotation`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules (where applicable).
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Document the contract event indexer cursor model and replay protection in INDEXER.md"
labels: type:docs, area:contracts, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Document the contract event indexer cursor model and replay protection in INDEXER.md

### Description
[`src/contracts/indexer.ts`](src/contracts/indexer.ts) and [`src/contracts/cursor.repository.ts`](src/contracts/cursor.repository.ts) implement cursor-based checkpointing and replay-safe ingestion of contract events, but the cursor format, checkpoint advancement rules, and duplicate-skipping guarantees are not documented in one place. Operators cannot reason about resume behavior after a crash.

This issue adds an `INDEXER.md` describing the cursor model and replay semantics.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Document the cursor shape (`sourceId`, `lastSequence`, `updatedAt`) and that it is opaque base64url.
- Explain how `processedCount`/`duplicateCount`/`errors` map to ingestion outcomes.
- Describe the at-least-once → effectively-once guarantee via dedupe in [`src/contracts/dedupe.ts`](src/contracts/dedupe.ts).
- Include a resume-after-crash walkthrough.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/contract-indexer-cursor-model`
- Implement changes
  - **Write code in:** no production change; documentation only.
  - **Write comprehensive tests in:** N/A — verify referenced symbols exist.
  - **Add documentation:** create `INDEXER.md` and link it from [`README.md`](README.md).
  - Validate security: ensure no internal source ids that are sensitive are exposed in examples.
- Test and commit

### Test and commit
- Run `npm run lint`.
- Verify links and code references resolve.

### Example commit message
`docs: document contract indexer cursor model and replay protection`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules (where applicable).
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a typed config accessor with fail-fast validation for queue tuning parameters"
labels: type:refactor, area:queue, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a typed config accessor with fail-fast validation for queue tuning parameters

### Description
[`src/queue/config.ts`](src/queue/config.ts) holds queue tuning values (concurrency, retry counts, backoff). If these are read directly from `process.env` or untyped objects, invalid values (negative concurrency, non-numeric retries) silently degrade the queue at runtime instead of failing at boot.

This issue adds a Zod-validated, typed accessor that fails fast on invalid queue configuration.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Define a Zod schema for queue tuning values with sane bounds (positive ints, bounded ranges).
- Parse once at startup; throw a clear error listing invalid fields if validation fails.
- Expose a typed config object consumed by [`src/queue/queue-manager.ts`](src/queue/queue-manager.ts) and [`src/queue/retry-manager.ts`](src/queue/retry-manager.ts).
- Align with the existing env validation approach in [`src/config/env.schema.ts`](src/config/env.schema.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/queue-config-typed-validation`
- Implement changes
  - **Write code in:** [`src/queue/config.ts`](src/queue/config.ts).
  - **Write comprehensive tests in:** [`src/queue/config.test.ts`](src/queue/config.test.ts) — assert valid config parses and invalid config throws with field details.
  - **Add documentation:** document queue config vars in [`README.md`](README.md).
  - Add JSDoc on the schema and accessor.
  - Validate security: ensure no secret is logged on a validation error.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: negative concurrency, zero retries, non-numeric backoff, and a fully valid config.

### Example commit message
`refactor: add fail-fast Zod validation for queue tuning config`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add health-service dependency check for the SQLite database connection"
labels: type:feature, area:health, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add health-service dependency check for the SQLite database connection

### Description
[`src/observability/health-service.ts`](src/observability/health-service.ts) and [`src/health/checker.ts`](src/health/checker.ts) aggregate readiness, but a database-connectivity probe is needed so the readiness endpoint reports `down` when the SQLite store in [`src/db/database.ts`](src/db/database.ts) is unavailable or locked. Without it, the service can report ready while every query fails.

This issue adds a lightweight DB ping probe to the readiness aggregation.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a probe that runs a trivial `SELECT 1`-style query against the database with a short timeout.
- Map success to `up`, slow responses to `degraded`, and failure to `down`.
- Register the probe in the health aggregation used by the readiness endpoint in [`src/health/router.ts`](src/health/router.ts).
- Avoid holding connections or running heavy queries in the probe.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/health-database-probe`
- Implement changes
  - **Write code in:** [`src/health/probes.ts`](src/health/probes.ts), [`src/observability/health-service.ts`](src/observability/health-service.ts).
  - **Write comprehensive tests in:** [`src/health/probes.test.ts`](src/health/probes.test.ts) — assert up/degraded/down mapping with a mocked DB.
  - **Add documentation:** document the DB probe in [`README.md`](README.md).
  - Add JSDoc on the probe.
  - Validate security: ensure the probe query cannot be influenced by user input.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: healthy DB, slow DB, and a thrown error from the DB.

### Example commit message
`feat: add SQLite connectivity probe to readiness health checks`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add upstream HTTP client connection-pool reuse and keep-alive tuning"
labels: type:enhancement, area:http-client, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add upstream HTTP client connection-pool reuse and keep-alive tuning

### Description
[`src/dependencies/upstreamHttpClient.ts`](src/dependencies/upstreamHttpClient.ts) makes outbound calls to upstream services. Without an explicit keep-alive agent and connection pool, every request may open a new TCP/TLS connection, adding latency and exhausting ephemeral ports under load.

This issue configures a reusable HTTP(S) agent with keep-alive and bounded pool size.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Configure a shared keep-alive agent with a bounded `maxSockets`/`maxFreeSockets`.
- Make pool sizing configurable through the config layer.
- Ensure SSRF protections in [`src/utils/ssrf.ts`](src/utils/ssrf.ts) remain enforced on every request.
- Preserve existing timeout and retry behavior in the client.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/upstream-http-keepalive-pool`
- Implement changes
  - **Write code in:** [`src/dependencies/upstreamHttpClient.ts`](src/dependencies/upstreamHttpClient.ts).
  - **Write comprehensive tests in:** [`src/dependencies/upstreamHttpClient.test.ts`](src/dependencies/upstreamHttpClient.test.ts) — assert agent reuse and pool bounds.
  - **Add documentation:** document pool config in [`README.md`](README.md).
  - Add JSDoc on the agent configuration.
  - Validate security: confirm SSRF checks still run before connection reuse.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: connection reuse across requests, pool saturation, and SSRF-blocked host.

### Example commit message
`feat: add keep-alive connection pooling to the upstream HTTP client`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add tests for the chaos policy targeting and probability gating edge cases"
labels: type:test, area:chaos, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add tests for the chaos policy targeting and probability gating edge cases

### Description
[`src/chaos/chaosPolicy.ts`](src/chaos/chaosPolicy.ts) decides whether to inject `error`/`timeout`/`none` for a named dependency based on `chaosMode`, `chaosTargets`, and `chaosProbability`. The targeting (case-insensitive match) and mode-dispatch branches need explicit coverage so chaos cannot accidentally fire on untargeted dependencies or in the default mode.

This issue adds tests for every branch of the decision logic (pairing with the injectable-RNG change once available).

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that an untargeted dependency always returns `none`.
- Test each `chaosMode` (`error`, `timeout`, `random`, default).
- Test case-insensitive target matching.
- Where the RNG is injectable, assert deterministic `random`-mode outcomes; otherwise stub `Math.random`.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/chaos-policy-targeting-branches`
- Implement changes
  - **Write code in:** no production change expected (coordinates with the injectable-RNG refactor).
  - **Write comprehensive tests in:** [`src/chaos/chaosPolicy.test.ts`](src/chaos/chaosPolicy.test.ts) — extend with branch coverage.
  - **Add documentation:** reference the tested decision matrix in JSDoc.
  - Validate security: confirm chaos never activates when not explicitly targeted.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty targets, mixed-case target, unknown mode, and probability extremes.

### Example commit message
`test: cover chaos policy targeting and mode-dispatch branches`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add request-body schema validation to the contracts create and update routes"
labels: type:security, area:contracts, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add request-body schema validation to the contracts create and update routes

### Description
The contract routes in [`src/routes/contracts.routes.ts`](src/routes/contracts.routes.ts) accept create/update payloads that flow into [`src/services/contracts.service.ts`](src/services/contracts.service.ts). Unless the `CreateContractDto`/`UpdateContractDto` in [`src/modules/contracts/dto/contract.dto.ts`](src/modules/contracts/dto/contract.dto.ts) are enforced by validation middleware on these routes, malformed or extra fields can reach the service and repository.

This issue wires the existing Zod DTOs through the validation middleware on the contract routes.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Apply [`src/middleware/validate.middleware.ts`](src/middleware/validate.middleware.ts) with the create/update DTOs on the respective routes.
- Strip unknown fields and reject type-mismatched payloads with a 400.
- Ensure validated input still satisfies bounds in [`src/contracts/bounds.ts`](src/contracts/bounds.ts).
- Keep the OpenAPI registration consistent with the enforced schema.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/contracts-route-body-validation`
- Implement changes
  - **Write code in:** [`src/routes/contracts.routes.ts`](src/routes/contracts.routes.ts).
  - **Write comprehensive tests in:** [`src/routes/contracts.test.ts`](src/routes/contracts.test.ts) — assert invalid bodies are rejected and valid bodies pass.
  - **Add documentation:** note the validation contract in [`README.md`](README.md).
  - Validate security: confirm no unknown field reaches the service.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: missing required field, wrong type, extra field, and a valid payload.

### Example commit message
`security: enforce Zod body validation on contract create/update routes`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add integration tests for the admin routes authorization guard"
labels: type:test, area:admin, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add integration tests for the admin routes authorization guard

### Description
[`src/routes/admin.routes.ts`](src/routes/admin.routes.ts) exposes operator-only endpoints protected by [`src/middleware/adminAuthGuard.ts`](src/middleware/adminAuthGuard.ts). The guard is the gate that keeps non-admins out of privileged operations, but end-to-end coverage asserting the guard actually blocks unauthorized callers across all admin routes is needed.

This issue adds integration tests exercising the admin routes with and without admin authorization.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test that each admin route returns 401/403 without valid admin credentials.
- Test that a valid admin principal is allowed through.
- Test that a non-admin authenticated user is rejected (authentication ≠ authorization).
- Drive the tests through the assembled app in [`src/app.ts`](src/app.ts) using supertest-style requests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/admin-routes-auth-guard`
- Implement changes
  - **Write code in:** no production change expected.
  - **Write comprehensive tests in:** [`src/routes/admin.routes.test.ts`](src/routes/admin.routes.test.ts) — extend with negative authorization cases.
  - **Add documentation:** reference the protected routes in JSDoc/README.
  - Validate security: confirm no admin route is reachable without the guard.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: missing token, non-admin token, admin token, and expired token.

### Example commit message
`test: add admin route authorization-guard integration tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add structured error codes to AppError subclasses for machine-readable API responses"
labels: type:enhancement, area:errors, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add structured error codes to AppError subclasses for machine-readable API responses

### Description
[`src/errors/appError.ts`](src/errors/appError.ts) defines `AppError` and subclasses (e.g. `NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`) used across services like [`src/services/reputation.service.ts`](src/services/reputation.service.ts). Responses carry a human message and HTTP status, but no stable machine-readable `code`, so clients must string-match messages to branch on error types.

This issue adds a stable `code` field to each error class and surfaces it in the serialized response via [`src/errors/safeErrors.ts`](src/errors/safeErrors.ts).

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a unique, stable `code` (e.g. `NOT_FOUND`, `VALIDATION_ERROR`) to each `AppError` subclass.
- Include `code` in the safe-serialized error body without leaking internals.
- Keep codes append-only/stable for client compatibility.
- Ensure the global error middleware emits the code.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/apperror-machine-codes`
- Implement changes
  - **Write code in:** [`src/errors/appError.ts`](src/errors/appError.ts), [`src/errors/safeErrors.ts`](src/errors/safeErrors.ts).
  - **Write comprehensive tests in:** [`src/errors/appError.test.ts`](src/errors/appError.test.ts) and [`src/errors/safeErrors.test.ts`](src/errors/safeErrors.test.ts) — assert each subclass carries its code and it appears in the serialized body.
  - **Add documentation:** list the error codes in [`README.md`](README.md).
  - Add JSDoc on the new `code` field.
  - Validate security: ensure codes reveal no internal detail.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: each subclass, a generic AppError, and a non-AppError fallthrough.

### Example commit message
`feat: add stable machine-readable codes to AppError subclasses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add optimistic-concurrency version checks to contract updates to prevent lost writes"
labels: type:feature, area:contracts, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add optimistic-concurrency version checks to contract updates to prevent lost writes

### Description
[`src/repositories/contractRepository.ts`](src/repositories/contractRepository.ts) exposes a `Contract` with a `version` field (per [`src/db/types.ts`](src/db/types.ts)), and there is an existing OCC integration test stub in [`src/contracts/occ.integration.test.ts`](src/contracts/occ.integration.test.ts). If updates in [`src/services/contracts.service.ts`](src/services/contracts.service.ts) do not check and bump the version, two concurrent edits can clobber each other (lost update).

This issue enforces optimistic concurrency on contract updates using the version column.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- On update, require the caller's expected `version`; bump it atomically and reject if it does not match (conflict).
- Throw `ConflictError` (from [`src/errors/appError.ts`](src/errors/appError.ts)) on a version mismatch.
- Ensure the version bump and row update are a single atomic statement.
- Keep reads returning the current `version` so clients can round-trip it.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/contracts-occ-version-check`
- Implement changes
  - **Write code in:** [`src/repositories/contractRepository.ts`](src/repositories/contractRepository.ts), [`src/services/contracts.service.ts`](src/services/contracts.service.ts).
  - **Write comprehensive tests in:** [`src/contracts/occ.integration.test.ts`](src/contracts/occ.integration.test.ts) — assert concurrent updates conflict and the version increments.
  - **Add documentation:** document the OCC contract in [`README.md`](README.md).
  - Add JSDoc on the versioned update method.
  - Validate security: ensure the version check cannot be bypassed.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: matching version, stale version, and missing version.

### Example commit message
`feat: enforce optimistic-concurrency version checks on contract updates`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add a graceful-shutdown drain for the TransactionPoller and queue workers"
labels: type:enhancement, area:lifecycle, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a graceful-shutdown drain for the TransactionPoller and queue workers

### Description
[`src/shutdown.ts`](src/shutdown.ts) coordinates graceful shutdown, but the `TransactionPoller` in [`src/services/TransactionPoller.ts`](src/services/TransactionPoller.ts) and the queue workers in [`src/queue/queue-manager.ts`](src/queue/queue-manager.ts) are not explicitly drained. On SIGTERM, an in-flight poll or job can be killed mid-flight, leaving transactions in `PENDING` and jobs half-processed.

This issue registers these components with the shutdown sequence so they stop accepting new work and finish or checkpoint in-flight work before exit.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- On shutdown, stop scheduling new polls/jobs and await in-flight ones up to a bounded grace period.
- After the grace period, checkpoint remaining state (depends on poller persistence) and exit cleanly.
- Hook into the existing shutdown registry in [`src/shutdown.ts`](src/shutdown.ts) rather than adding a parallel handler.
- Ensure idempotent shutdown (multiple SIGTERMs do not double-run the drain).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/shutdown-drain-poller-and-queue`
- Implement changes
  - **Write code in:** [`src/shutdown.ts`](src/shutdown.ts), [`src/services/TransactionPoller.ts`](src/services/TransactionPoller.ts), [`src/queue/queue-manager.ts`](src/queue/queue-manager.ts).
  - **Write comprehensive tests in:** [`src/shutdown.test.ts`](src/shutdown.test.ts) — assert new work is refused and in-flight work is awaited/checkpointed.
  - **Add documentation:** document the shutdown order in [`README.md`](README.md).
  - Add JSDoc on the registered drain handlers.
  - Validate security: ensure no work is silently dropped without a checkpoint.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: shutdown with no in-flight work, in-flight work finishing in time, and grace-period timeout.

### Example commit message
`feat: drain TransactionPoller and queue workers during graceful shutdown`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
++++++
---
type: Feature
title: "Add JSON-shape and column-order golden tests for the audit CSV and JSON exporter"
labels: type:test, area:audit, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add JSON-shape and column-order golden tests for the audit CSV and JSON exporter

### Description
[`src/audit/exportService.ts`](src/audit/exportService.ts) produces CSV and JSON exports of audit records. The exact CSV column order, header row, and escaping of fields containing commas, quotes, or newlines are part of the contract that downstream tools depend on, yet there is no test pinning the serialized format precisely. A silent format change could break consumers without any test failing.

This issue adds golden-format tests for CSV escaping, column order, and JSON shape.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Test the CSV header and column order against a fixed expected layout.
- Test escaping of fields containing commas, double quotes, and embedded newlines.
- Test the JSON export shape and that redaction from [`src/audit/redact.ts`](src/audit/redact.ts) is applied.
- Use a deterministic fixture set of audit rows so the golden output is stable.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/audit-export-format-golden`
- Implement changes
  - **Write code in:** no production change expected (export only what is needed for testing).
  - **Write comprehensive tests in:** [`src/audit/exportService.test.ts`](src/audit/exportService.test.ts) — add golden-format assertions.
  - **Add documentation:** document the CSV/JSON format contract in JSDoc on the exporter.
  - Validate security: confirm redacted fields are masked in both formats.
- Test and commit

### Test and commit
- Run `npm test` and `npm run lint`.
- Cover edge cases: empty export, field with embedded comma/quote/newline, and a redacted field.

### Example commit message
`test: pin audit CSV escaping, column order, and JSON export format`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
