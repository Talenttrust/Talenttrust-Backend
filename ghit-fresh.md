---
type: Feature
title: "Implement a real email transport in the email queue processor"
labels: type:feature, area:queue, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Implement a real email transport in the email queue processor

### Description
`processEmailNotification` in [`src/queue/processors/email-processor.ts`](src/queue/processors/email-processor.ts) does not send email — it validates `subject`/`body`, then calls `simulateEmailSend`, which only `console.log`s the payload and resolves after a 100ms `setTimeout`. The function returns `{ success: true }` regardless, so every queued email job "succeeds" while nothing is delivered. The inline comments explicitly say "replace with actual email service integration" (SendGrid, AWS SES, etc.). This issue wires a real, injectable email transport so queued notifications are actually delivered.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Introduce an `EmailTransport` interface so a real provider (SMTP/SendGrid/SES) can be configured and a mock injected in tests; select the transport from validated config in [`src/config/env.schema.ts`](src/config/env.schema.ts).
- Replace `simulateEmailSend` with a real dispatch that surfaces provider failures so the job fails (and is retried) instead of silently succeeding.
- Validate the recipient `to` with a strict email check and guard against header injection before dispatch.
- Keep the existing return shape `{ success, message, data: { emailId } }` and the job-failure semantics expected by the queue manager in [`src/queue/queue-manager.ts`](src/queue/queue-manager.ts).
- Do not log full recipient addresses or bodies at info level; route through the structured logger in [`src/logger.ts`](src/logger.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/queue-31-email-transport`
- Implement changes
  - **Write code in:** [`src/queue/processors/email-processor.ts`](src/queue/processors/email-processor.ts) and create `src/queue/processors/email.transport.ts`.
  - **Write comprehensive tests in:** [`src/queue/processors/email-processor.test.ts`](src/queue/processors/email-processor.test.ts) — mock the transport and assert delivery, provider-failure propagation, and recipient validation.
  - **Add documentation:** create `docs/email-notifications.md` describing transport selection and config.
  - Add TSDoc to the new interface and dispatch method.
  - Validate security: header-injection guard, no PII in logs.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: missing subject/body, invalid recipient, transport throws, transport timeout.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(queue): implement real email transport in the email processor`

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
title: "Wire the blockchain sync queue processor to real RPC block ingestion"
labels: type:feature, area:queue, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Wire the blockchain sync queue processor to real RPC block ingestion

### Description
`processBlockchainSync` in [`src/queue/processors/blockchain-processor.ts`](src/queue/processors/blockchain-processor.ts) iterates a block range and calls a `processBatch` helper that does nothing but `console.log(\`Processed ${network} blocks ...\`)` after an artificial delay — no RPC calls and no events are ingested. The job reports success while no blockchain data is synced. This issue connects the processor to the real Stellar/Soroban RPC layer already present in [`src/services/soroban/SorobanRpcService.ts`](src/services/soroban/SorobanRpcService.ts) and persists ingested events through the existing indexer.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace `processBatch` with real ledger/event fetches via [`src/services/soroban/SorobanRpcService.ts`](src/services/soroban/SorobanRpcService.ts), using `SOROBAN_RPC_URL`/`SOROBAN_CONTRACT_ID` from [`src/config/env.schema.ts`](src/config/env.schema.ts).
- Persist ingested events idempotently through [`src/services/indexer.ts`](src/services/indexer.ts), reusing dedupe in [`src/contracts/dedupe.ts`](src/contracts/dedupe.ts) so replayed batches do not double-write.
- Wrap RPC calls in the existing breaker from [`src/circuit-breaker/CircuitBreaker.ts`](src/circuit-breaker/CircuitBreaker.ts); fail the job (so it retries) on RPC error instead of resolving silently.
- Track the last-synced block so a restarted job resumes rather than re-scanning from zero.
- Apply SSRF guards via [`src/utils/ssrf.ts`](src/utils/ssrf.ts) on the configured RPC URL.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/queue-32-blockchain-sync-rpc`
- Implement changes
  - **Write code in:** [`src/queue/processors/blockchain-processor.ts`](src/queue/processors/blockchain-processor.ts).
  - **Write comprehensive tests in:** [`src/queue/processors/blockchain-processor.test.ts`](src/queue/processors/blockchain-processor.test.ts) — mock the RPC client and indexer; assert ingestion, idempotency, breaker-open, and resume.
  - **Add documentation:** update the Soroban/sync section of [`README.md`](README.md).
  - Add TSDoc to the ingestion helper.
  - Validate security: SSRF guard on RPC URL; no secrets in logs.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty range, RPC timeout, breaker open, duplicate batch replay.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(queue): wire blockchain sync processor to real RPC block ingestion`

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
title: "Replace mock freelancer enumeration in the reputation recompute processor"
labels: type:feature, area:queue, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Replace mock freelancer enumeration in the reputation recompute processor

### Description
`getAllFreelancerIds` in [`src/queue/processors/reputation-recompute-processor.ts`](src/queue/processors/reputation-recompute-processor.ts) is a hardcoded stub that returns synthetic ids `freelancer-1 … freelancer-1000` in a loop, with a comment stating "this is a mock implementation - in production, this would query the database." As a result, the bulk recompute job operates on fake ids and never recomputes a single real freelancer's score. This issue replaces the stub with a real, paginated query against the reputation store so the job recomputes actual subjects.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace `getAllFreelancerIds` with a query against [`src/repositories/reputationRepository.ts`](src/repositories/reputationRepository.ts) / [`src/models/reputation.store.ts`](src/models/reputation.store.ts) that returns the distinct subject ids that actually have ratings.
- Stream/paginate the id list so recompute does not load the entire table into memory at once.
- Reuse the aggregation in [`src/services/reputation.service.ts`](src/services/reputation.service.ts) and persist a checkpoint via [`src/models/reputation-checkpoint.store.ts`](src/models/reputation-checkpoint.store.ts) so on-demand and scheduled recompute stay consistent.
- Preserve the per-subject error isolation already in the processor (one failure must not abort the batch).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/queue-33-real-freelancer-recompute`
- Implement changes
  - **Write code in:** [`src/queue/processors/reputation-recompute-processor.ts`](src/queue/processors/reputation-recompute-processor.ts).
  - **Write comprehensive tests in:** [`src/queue/processors/reputation-recompute-processor.test.ts`](src/queue/processors/reputation-recompute-processor.test.ts) — mock the repository; assert pagination, per-subject isolation, and checkpoint writes.
  - **Add documentation:** note the recompute flow in `docs/reputation-scoring.md` (or create it if absent).
  - Add TSDoc to the new query method.
  - Validate: empty store yields zero work without error.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: no freelancers, single page, multi-page, one subject throwing.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(queue): query real freelancer ids in reputation recompute processor`

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
title: "Implement real deployment promotion, rollback, and promotion history"
labels: type:feature, area:deployment, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Implement real deployment promotion, rollback, and promotion history

### Description
`promoteDeployment` and `rollbackDeployment` in [`src/deployment/promoter.ts`](src/deployment/promoter.ts) return a success object without doing anything — the inline comments list the intended steps ("tag the version, trigger pipeline, run smoke tests, update registry") and then immediately return a mock. `getPromotionHistory` likewise returns an empty array ("for now, return empty array"). Operators see "promoted" responses with no real effect and no audit trail. This issue implements real promotion/rollback orchestration with persisted history.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Implement `promoteDeployment` to run the deployment validator in [`src/deployment/validator.ts`](src/deployment/validator.ts), execute a health/smoke check against the target, and only then record the promotion.
- Persist promotion/rollback records (timestamp, from→to, actor, outcome) so `getPromotionHistory` returns real data; emit an audit entry via [`src/audit/service.ts`](src/audit/service.ts).
- Implement `rollbackDeployment` to restore the previous recorded version and write a corresponding history/audit entry.
- Keep the existing function signatures and the success/error shape consumed by [`src/routes/deploy.routes.ts`](src/routes/deploy.routes.ts).
- Reuse the blue-green color/port logic in [`src/deploy.ts`](src/deploy.ts) rather than duplicating it.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/deployment-34-real-promotion`
- Implement changes
  - **Write code in:** [`src/deployment/promoter.ts`](src/deployment/promoter.ts).
  - **Write comprehensive tests in:** [`src/deployment/promoter.test.ts`](src/deployment/promoter.test.ts) — assert validation gate, history persistence, rollback restores prior version, and audit emission.
  - **Add documentation:** update [`docs/deploy.md`](docs/deploy.md) with the promotion/rollback lifecycle.
  - Add TSDoc to the three functions.
  - Validate: failed validation blocks promotion; rollback is recorded.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: validation failure, rollback with no prior version, repeated promotion, history ordering.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(deployment): implement real promotion, rollback, and persisted history`

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
title: "Implement archived-data listing and statistics in the retention archival service"
labels: type:feature, area:retention, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Implement archived-data listing and statistics in the retention archival service

### Description
`listArchivedData` and `getArchiveStats` in [`src/retention/archival.ts`](src/retention/archival.ts) are stubs: `listArchivedData` always returns `[]` (with a "placeholder for more comprehensive listing" comment) and `getArchiveStats` returns `{ totalArchived: 0, byStorageType: {} }`. This makes the archived-data inventory invisible — a problem for compliance reporting (GDPR/retention audits) and for the purge flow in [`src/retention/purge.ts`](src/retention/purge.ts), which has no accurate view of what has been archived. This issue implements real enumeration and statistics over the configured storage backends.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Implement `listArchivedData(storageType?)` to enumerate archived records from the storage layer in [`src/retention/storage.ts`](src/retention/storage.ts), filtering by `ArchivalStorageType` when provided.
- Implement `getArchiveStats()` to return a real `totalArchived` count and a `byStorageType` breakdown derived from the storage layer.
- Support pagination/bounded reads so large archives do not load fully into memory.
- Preserve the existing `RetainedData` shape from [`src/retention/types.ts`](src/retention/types.ts) and the policies in [`src/retention/policies.ts`](src/retention/policies.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/retention-35-archive-inventory`
- Implement changes
  - **Write code in:** [`src/retention/archival.ts`](src/retention/archival.ts).
  - **Write comprehensive tests in:** [`src/retention/retention.test.ts`](src/retention/retention.test.ts) — seed mock archives across storage types and assert listing/filtering and stat counts.
  - **Add documentation:** update [`docs/DATA_RETENTION.md`](docs/DATA_RETENTION.md) with the inventory/stats API.
  - Add TSDoc to both methods.
  - Validate: counts match listed records across storage types.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty archive, single storage type, mixed storage types, pagination boundary.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(retention): implement archived-data listing and statistics`

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
title: "Add queue and circuit-breaker health probes to the readiness endpoint"
labels: type:enhancement, area:health, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add queue and circuit-breaker health probes to the readiness endpoint

### Description
The probes in [`src/health/probes.ts`](src/health/probes.ts) cover environment, database, Redis, and Stellar RPC, but they do not surface the health of background job processing. `QueueManager.getHealth()` already exists in [`src/queue/queue-manager.ts`](src/queue/queue-manager.ts) and the breaker registry in [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts) tracks open breakers — yet neither is wired into the health check. A node can report "ready" while its queues are backed up or breakers are tripped, so load balancers keep routing traffic to a broken instance. This issue adds probes for queue and breaker health.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a `queueProbe` that calls `QueueManager.getHealth()` and reports degraded/failed when failed-job counts or backlog exceed configurable thresholds.
- Add a `circuitBreakerProbe` that reports the number of open breakers from [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts).
- Register both in the probe runner so they appear in `/health/ready` via [`src/health/router.ts`](src/health/router.ts); keep probe timeouts bounded so health never blocks.
- Make probe thresholds configurable through the validated config and do not leak internal error detail in the response body.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/health-36-queue-breaker-probes`
- Implement changes
  - **Write code in:** [`src/health/probes.ts`](src/health/probes.ts).
  - **Write comprehensive tests in:** [`src/health/probes.test.ts`](src/health/probes.test.ts) — mock queue/breaker state and assert ok/degraded/failed mapping and timeout safety.
  - **Add documentation:** update the health section of [`README.md`](README.md) and any health docs.
  - Add TSDoc to the new probes.
  - Validate: probes are bounded and never throw out of the runner.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: healthy queue, backed-up queue, one breaker open, probe timeout.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(health): add queue and circuit-breaker readiness probes`

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
title: "Replace O(n) API key validation with an indexed hashed-key lookup"
labels: type:enhancement, area:api-keys, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Replace O(n) API key validation with an indexed hashed-key lookup

### Description
`validateApiKey` in [`src/auth/apiKeys.ts`](src/auth/apiKeys.ts) loads every active key and loops over them, calling `verifyApiKey` (PBKDF2) once per stored key until a match is found — the code's own comment admits "in a real implementation, you'd need to iterate through keys or use an index." With N active keys this runs up to N expensive PBKDF2 hashes on every authenticated request, a clear scaling and DoS-amplification risk. This issue introduces an indexed lookup so validation is O(1) in the number of stored keys.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a deterministic lookup index: store a separate fast key-id/selector (e.g. HMAC or SHA-256 of the presented key, distinct from the slow per-key salted hash) so a candidate row can be found without scanning all keys.
- After the indexed lookup, still verify with the existing salted `verifyApiKey` to keep the strong per-key hash as the source of truth.
- Preserve expiry deactivation, `last_used_at` update, and the returned `ApiKeyInfo` shape.
- Provide a migration so existing keys gain the new selector without invalidating them.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/api-keys-37-indexed-lookup`
- Implement changes
  - **Write code in:** [`src/auth/apiKeys.ts`](src/auth/apiKeys.ts) and a migration in [`src/db/migrations.ts`](src/db/migrations.ts).
  - **Write comprehensive tests in:** [`src/auth/__tests__/apiKeys.test.ts`](src/auth/__tests__/apiKeys.test.ts) — assert single-hash lookup, expired-key deactivation, and unknown-key rejection.
  - **Add documentation:** update [`docs/api-keys.md`](docs/api-keys.md) with the lookup model.
  - Add TSDoc to the new lookup helper.
  - Validate security: selector is non-reversible; verification still uses the salted hash; constant-time compare on the selector.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: no keys, expired key, revoked key, valid key among many.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`feat(api-keys): add indexed lookup to remove O(n) key validation scan`

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
title: "Add unit tests for the stale-while-revalidate cache utility"
labels: type:test, area:utils, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the stale-while-revalidate cache utility

### Description
`SWRCache` in [`src/utils/swrCache.ts`](src/utils/swrCache.ts) serves cached values, triggers background revalidation, coalesces in-flight fetches, and swallows revalidation errors with a single `console.error` — but it has no test file. Its concurrency and staleness behavior gate any consumer that relies on it, and untested cache stampede / error handling is a latent reliability risk. This issue adds a deterministic unit suite.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert a fresh hit returns the cached value without calling the fetcher.
- Assert a stale hit returns the stale value immediately and revalidates in the background exactly once (coalescing concurrent callers).
- Assert a cache miss awaits the fetcher and populates the entry.
- Assert a failed background revalidation does not throw to callers and the stale value is retained.
- Use fake timers to control TTL/staleness deterministically; no real delays.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/utils-38-swr-cache`
- Implement changes
  - **Write comprehensive tests in:** create `src/utils/swrCache.test.ts`.
  - **Write code in:** none expected beyond a minimal test seam if required.
  - **Add documentation:** add usage notes in TSDoc on `SWRCache`.
  - Add TSDoc to shared test helpers.
  - Validate: tests are deterministic and leave no open timers.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: fresh, stale-with-revalidate, miss, revalidation error, concurrent miss coalescing.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(utils): add deterministic coverage for SWR cache`

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
title: "Add tests for the timing-safe deduplication manager"
labels: type:test, area:utils, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the timing-safe deduplication manager

### Description
`DeduplicationManager` in [`src/utils/deduplication.ts`](src/utils/deduplication.ts) hashes payloads and compares them with `crypto.timingSafeEqual`, including an explicit equal-length guard before the constant-time compare. This is security-sensitive (timing-attack resistance) and gates dedupe correctness, yet there is no test file. This issue adds focused coverage for hashing, equal/unequal comparison, and the length-guard branch.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert identical payloads are detected as duplicates and distinct payloads are not.
- Assert the equal-length guard is exercised so `timingSafeEqual` is never called with mismatched buffer lengths.
- Assert the hash is stable for identical input and changes for different input.
- Cover any TTL/eviction behavior the manager exposes deterministically (fake timers if time-based).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/utils-39-deduplication`
- Implement changes
  - **Write comprehensive tests in:** create `src/utils/deduplication.test.ts`.
  - **Write code in:** none expected.
  - **Add documentation:** add TSDoc clarifying the timing-safe rationale.
  - Add TSDoc to shared test helpers.
  - Validate security: no comparison path bypasses the length guard.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: identical payload, different payload, different-length payloads, empty payload.
- Include the full `npm test` output and a short security notes section in the PR.

### Example commit message
`test(utils): cover timing-safe deduplication manager`

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
title: "Add unit tests for the API key and audit middleware"
labels: type:test, area:audit, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the API key and audit middleware in isolation

### Description
Three request-path middleware modules have no dedicated unit tests: [`src/auth/apiKeyMiddleware.ts`](src/auth/apiKeyMiddleware.ts) (`authenticateApiKey`, `requireApiKeyScope`, `authenticateEither`), [`src/audit/middleware.ts`](src/audit/middleware.ts) (the `auditMiddleware` request wrapper), and [`src/audit/protectedEndpointMiddleware.ts`](src/audit/protectedEndpointMiddleware.ts) (the `res.on('finish')` audit hook). These guard authentication fallbacks, scope checks, and audit-trail emission, so their error and edge paths are security-critical and currently unverified. This issue adds isolated coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- For `authenticateApiKey`: assert missing/invalid `X-API-Key` is rejected and a valid key populates the request principal.
- For `requireApiKeyScope`: assert scope match, scope mismatch (403), and missing-scope handling.
- For `authenticateEither`: assert the JWT path and the API-key fallback path, plus the both-missing rejection.
- For the audit middleware: assert an audit entry is emitted on response finish with correlation id and that handler errors still produce an audit record.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/audit-40-middleware-coverage`
- Implement changes
  - **Write comprehensive tests in:** create `src/auth/apiKeyMiddleware.test.ts`, `src/audit/middleware.test.ts`, and `src/audit/protectedEndpointMiddleware.test.ts`.
  - **Write code in:** none expected beyond minimal test seams.
  - **Add documentation:** note the covered scenarios in the relevant module TSDoc.
  - Add TSDoc to shared mocks/helpers.
  - Validate security: 401/403 paths do not leak internal detail.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: missing header, wrong scope, JWT+API-key fallback, audit on error.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(audit): add unit coverage for API key and audit middleware`

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
title: "Add tests for the utils redaction helper and webhook metrics counters"
labels: type:test, area:observability, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the utils redaction helper and webhook metrics counters

### Description
Two observability/security utilities ship without test files: [`src/utils/redact.ts`](src/utils/redact.ts) (sensitive-field redaction used before logging) and [`src/utils/webhookMetrics.ts`](src/utils/webhookMetrics.ts) (the counters/gauges for webhook delivery). Untested redaction risks leaking secrets into logs, and untested metric accumulation risks silently wrong dashboards. This issue adds focused coverage for both.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- For redaction: assert known sensitive keys (tokens, auth headers, secrets) are masked, nested objects are handled, and non-sensitive fields pass through unchanged.
- For webhook metrics: assert outcome counters increment for success/retry/dlq and that label cardinality stays bounded (host/status only, never raw URLs).
- Keep tests independent of any live Prometheus registry by resetting metrics between cases.
- Do not assert on real secret values in test output.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/observability-41-redact-webhook-metrics`
- Implement changes
  - **Write comprehensive tests in:** create `src/utils/redact.test.ts` and `src/utils/webhookMetrics.test.ts`.
  - **Write code in:** none expected.
  - **Add documentation:** note redaction keys and metric names in TSDoc.
  - Add TSDoc to shared fixtures.
  - Validate security: no secret value appears in assertions or snapshots.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: nested sensitive object, unknown key, success/retry/dlq increments, label bounds.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(observability): cover redaction helper and webhook metrics counters`

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
title: "Remove the hardcoded fallback HMAC secret in compliance audit proof generation"
labels: type:security, area:retention, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Harden compliance audit proofs by removing the hardcoded HMAC secret

### Description
`generateProof` in [`src/retention/audit.ts`](src/retention/audit.ts) builds an HMAC over compliance audit records using `process.env.COMPLIANCE_AUDIT_SECRET || 'talenttrust-compliance-secret-key-2024'`. When the env var is unset, the proof is signed with a secret that is committed to source control — anyone can forge or validate proofs, which defeats the tamper-evidence the audit trail is supposed to provide for DELETE/ARCHIVE operations. This issue removes the fallback and fails fast when the secret is absent.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Delete the literal fallback; require `COMPLIANCE_AUDIT_SECRET` and read it from the validated config in [`src/config/env.schema.ts`](src/config/env.schema.ts) with a minimum length.
- Fail fast at startup (consistent with the existing `validateEnv` behavior) when the secret is missing outside tests, rather than silently signing with a weak key.
- Never log the secret value; preserve any existing security notes in the file.
- Update [`.env.example`](.env.example) with guidance on generating a strong secret.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/retention-42-audit-proof-secret`
- Implement changes
  - **Write code in:** [`src/retention/audit.ts`](src/retention/audit.ts) and [`src/config/env.schema.ts`](src/config/env.schema.ts).
  - **Write comprehensive tests in:** [`src/retention/retention.test.ts`](src/retention/retention.test.ts) — assert proof verification with a configured secret and that boot fails without one.
  - **Add documentation:** update [`docs/DATA_RETENTION.md`](docs/DATA_RETENTION.md) and [`.env.example`](.env.example).
  - Add TSDoc explaining the security rationale.
  - Validate security: no fallback secret remains; secret never appears in logs or errors.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: missing secret, short secret, valid secret, tampered record fails verification.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(security): require COMPLIANCE_AUDIT_SECRET and drop hardcoded fallback`

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
title: "Make contract-metadata sensitive masking fail-closed when the caller is unknown"
labels: type:security, area:contract-metadata, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Harden contract-metadata masking to fail closed on unknown callers

### Description
`formatResponse` in [`src/modules/contractMetadata/contractMetadata.service.ts`](src/modules/contractMetadata/contractMetadata.service.ts) masks sensitive values only when `metadata.is_sensitive && user && metadata.created_by !== user.id && user.role !== 'admin'`. Because the condition requires `user` to be truthy to mask, a request where `user` is `undefined` (the controller passes an optional `req.user`) skips masking entirely and returns the raw sensitive value. This is fail-open: an unauthenticated/unknown caller sees more than an authenticated non-owner. This issue inverts the logic so masking is the default and only the owner/admin sees the clear value.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Recompute `shouldMaskValue` so that for an `is_sensitive` record the value is masked unless the caller is the owner (`metadata.created_by === user.id`) or an `admin`; an absent/undefined `user` must always be masked.
- Keep the `***REDACTED***` placeholder and the rest of the response shape unchanged.
- Ensure the controller in [`src/modules/contractMetadata/contractMetadata.controller.ts`](src/modules/contractMetadata/contractMetadata.controller.ts) passes the authenticated user consistently.
- This is a fail-closed security fix; do not broaden who can see clear values.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/contract-metadata-43-mask-fail-closed`
- Implement changes
  - **Write code in:** [`src/modules/contractMetadata/contractMetadata.service.ts`](src/modules/contractMetadata/contractMetadata.service.ts).
  - **Write comprehensive tests in:** [`src/modules/contractMetadata/contractMetadata.test.ts`](src/modules/contractMetadata/contractMetadata.test.ts) — assert masking for undefined user, non-owner, and clear value only for owner/admin.
  - **Add documentation:** note the masking rule in the module TSDoc and [`docs/API.md`](docs/API.md).
  - Add TSDoc to `formatResponse`.
  - Validate security: no path returns a sensitive clear value to an unknown caller.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: undefined user, non-owner user, owner, admin, non-sensitive record.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(security): fail closed on contract-metadata sensitive masking`

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
title: "Replace the always-true blue-green health checker with a real readiness probe"
labels: type:security, area:deployment, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Replace the always-true blue-green health checker with a real readiness probe

### Description
The default `_healthChecker` in [`src/deploy.ts`](src/deploy.ts) is a stub that always returns `true` (its comment shows the intended `GET /health/ready` check that was never implemented). `switchToGreen` relies on this checker before cutting traffic over, so a blue-green deployment will promote an instance that is actually unhealthy — defeating the entire safety gate. This issue replaces the mock with a real, timeout-bounded HTTP readiness probe.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Implement the default checker to call the target's `/health/ready` endpoint (served by [`src/health/router.ts`](src/health/router.ts)) and treat only a `200`/ready response as healthy.
- Apply a bounded timeout and a small retry/poll window before declaring failure; keep the existing injectable seam (`setHealthChecker`) for tests.
- Validate the target URL/port with the SSRF guard in [`src/utils/ssrf.ts`](src/utils/ssrf.ts) so the probe cannot be pointed at arbitrary internal hosts.
- Ensure `switchToGreen` aborts the cutover (no traffic switch) when the probe fails.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/deployment-44-real-health-checker`
- Implement changes
  - **Write code in:** [`src/deploy.ts`](src/deploy.ts).
  - **Write comprehensive tests in:** [`src/deploy.test.ts`](src/deploy.test.ts) — mock the HTTP probe and assert healthy→switch, unhealthy→abort, and timeout handling.
  - **Add documentation:** update [`docs/deploy.md`](docs/deploy.md) with the readiness-gate behavior.
  - Add TSDoc to the checker.
  - Validate security: SSRF guard on the probe target; bounded timeout.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: ready 200, not-ready 503, connection refused, probe timeout.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(deployment): use a real readiness probe in the blue-green health checker`

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
title: "Document the API key lifecycle, scopes, and rotation"
labels: type:docs, area:api-keys, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Document the API key lifecycle, scopes, and rotation

### Description
API keys are created, validated, scoped, and revoked across [`src/auth/apiKeys.ts`](src/auth/apiKeys.ts), [`src/auth/apiKeyMiddleware.ts`](src/auth/apiKeyMiddleware.ts), [`src/controllers/apiKeyController.ts`](src/controllers/apiKeyController.ts), and [`src/routes/apiKeys.routes.ts`](src/routes/apiKeys.routes.ts), with hashing via salted PBKDF2 and per-key scopes. The existing [`docs/api-keys.md`](docs/api-keys.md) does not fully explain the lifecycle (issue → use → expire → revoke), the scope vocabulary, or rotation guidance. This issue completes the integrator-facing documentation.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Document key creation, the returned plaintext-once secret, hashing/storage (salt:hash), and how `X-API-Key` is presented on requests.
- Enumerate the available scopes and how `requireApiKeyScope` enforces them, plus the JWT-or-key fallback via `authenticateEither`.
- Describe expiry/`expires_at` deactivation, revocation, and a recommended rotation procedure.
- Cross-link the auth section of [`README.md`](README.md).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/api-keys-45-lifecycle`
- Implement changes
  - **Write code in:** none beyond doc-only clarifying TSDoc.
  - **Write comprehensive tests in:** rely on existing API key tests to confirm documented behavior.
  - **Add documentation:** expand [`docs/api-keys.md`](docs/api-keys.md).
  - Ensure documented scopes match the code.
  - Validate: examples reflect real request/response shapes.
- Test and commit

### Test and commit
- Run `npm run lint` to ensure no drift.
- Cross-check documented scopes and headers against the implementation.
- Include notes in the PR confirming accuracy.

### Example commit message
`docs(api-keys): document key lifecycle, scopes, and rotation`

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
title: "Document the data retention, archival, and purge lifecycle"
labels: type:docs, area:retention, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Document the data retention, archival, and purge lifecycle

### Description
The retention subsystem spans policies in [`src/retention/policies.ts`](src/retention/policies.ts), archival in [`src/retention/archival.ts`](src/retention/archival.ts), purge in [`src/retention/purge.ts`](src/retention/purge.ts), storage in [`src/retention/storage.ts`](src/retention/storage.ts), and compliance audit proofs in [`src/retention/audit.ts`](src/retention/audit.ts), with a partial [`docs/DATA_RETENTION.md`](docs/DATA_RETENTION.md). Operators lack a single guide describing how data flows from active → archived → purged and how compliance proofs are generated. This issue completes that documentation.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Describe the retention policy model, how archival selects records, and how purge enforces deletion windows.
- Document the storage backends/types and how compliance proofs (HMAC) make DELETE/ARCHIVE actions tamper-evident.
- Explain configuration (retention periods, the audit secret) and the safety guarantees (idempotent re-runs).
- Include a sequence diagram of active → archive → purge with a proof checkpoint.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/retention-46-lifecycle`
- Implement changes
  - **Write code in:** none beyond doc-only clarifying comments.
  - **Write comprehensive tests in:** rely on [`src/retention/retention.test.ts`](src/retention/retention.test.ts) and [`src/retention/purge.test.ts`](src/retention/purge.test.ts) to confirm behavior matches docs.
  - **Add documentation:** expand [`docs/DATA_RETENTION.md`](docs/DATA_RETENTION.md) and link it from [`README.md`](README.md).
  - Ensure documented policies match the constants in code.
  - Validate: diagram and steps match the implementation.
- Test and commit

### Test and commit
- Run `npm run lint` to ensure no drift.
- Cross-check documented retention windows against [`src/retention/policies.ts`](src/retention/policies.ts).
- Include notes in the PR confirming accuracy.

### Example commit message
`docs(retention): document retention, archival, and purge lifecycle`

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
title: "Route queue processor logging through Pino and use crypto-strong job ids"
labels: type:refactor, area:queue, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Refactor queue processors onto structured logging and strong ids

### Description
The queue processors log with raw `console.log` instead of the structured Pino logger used elsewhere — [`src/queue/processors/email-processor.ts`](src/queue/processors/email-processor.ts), [`src/queue/processors/blockchain-processor.ts`](src/queue/processors/blockchain-processor.ts), [`src/queue/processors/reputation-processor.ts`](src/queue/processors/reputation-processor.ts), and [`src/queue/processors/contract-processor.ts`](src/queue/processors/contract-processor.ts) all bypass [`src/logger.ts`](src/logger.ts), breaking log aggregation and correlation, and the contract processor logs ids straight to stdout. Separately, `generateEmailId` uses `Date.now()` + `Math.random().toString(36)`, which is collision-prone and not suitable for ids. This behavior-preserving refactor moves all processor logging onto Pino and switches id generation to a crypto-strong source.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace `console.*` in all four processors with the structured logger from [`src/logger.ts`](src/logger.ts), attaching correlation/job context and applying redaction from [`src/utils/redact.ts`](src/utils/redact.ts) where payloads are logged.
- Replace `generateEmailId` (and any similar `Date.now()+Math.random()` id) with `crypto.randomUUID()` (or `randomBytes`).
- Do not change job outcomes, return shapes, or retry behavior; this is purely logging + id generation.
- Avoid logging recipient PII or contract ids at info level in plaintext.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/queue-47-structured-logging-ids`
- Implement changes
  - **Write code in:** the four processor files listed above.
  - **Write comprehensive tests in:** the existing processor test files (e.g. [`src/queue/processors/email-processor.test.ts`](src/queue/processors/email-processor.test.ts)) — assert structured log shape, redaction, and unique id generation.
  - **Add documentation:** note the logging convention in the queue section of [`README.md`](README.md).
  - Add TSDoc to the id helper.
  - Validate: no secrets/PII in logs; ids are unique across rapid calls.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: rapid successive id generation, payload with sensitive fields, processor error path logging.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`refactor(queue): use Pino logging and crypto-strong ids in processors`

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
title: "Add per-request timeout and retry to the default Stellar RPC transport"
labels: type:enhancement, area:stellar, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add per-request timeout and retry to the default Stellar RPC transport

### Description
`defaultTransport` in [`src/rpc/stellarClient.ts`](src/rpc/stellarClient.ts) calls `fetch` with no timeout, no abort, and no HTTP-level retry. Its own doc comment admits this is "intentionally simple: real production code would also set a request timeout, add auth headers, and handle HTTP-level retries before the circuit breaker," and the file header references a `STELLAR_RPC_TIMEOUT_MS` env var that is never read. A hung Soroban RPC therefore stalls the calling request indefinitely and the circuit breaker (5-failure threshold) never trips because the call neither succeeds nor fails. This issue gives the transport a bounded, abortable request lifecycle.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Wrap the `fetch` in `defaultTransport` with an `AbortController` driven by a `STELLAR_RPC_TIMEOUT_MS` env var (sane default), aborting and throwing a typed timeout error so the breaker counts it as a failure.
- Add a small bounded HTTP-level retry (idempotent reads only) with jitter, layered *below* the `CircuitBreaker` in [`src/circuit-breaker/CircuitBreaker.ts`](src/circuit-breaker/CircuitBreaker.ts) so retries and breaker accounting do not double-count.
- Keep the injectable `Transport` seam intact so tests pass a mock; do not hard-code the production URL.
- Surface the timeout value through validated config rather than reading `process.env` inline twice.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/stellar-rpc-transport-timeout`
- Implement changes
  - **Write code in:** [`src/rpc/stellarClient.ts`](src/rpc/stellarClient.ts).
  - **Write comprehensive tests in:** create `src/rpc/stellarClient.test.ts` — fake timers/abort; assert timeout aborts the fetch, retries are bounded, and the breaker records failures.
  - **Add documentation:** update [`docs/backend/SOROBAN_RPC.md`](docs/backend/SOROBAN_RPC.md) with the timeout/retry env vars.
  - Add TSDoc to the timeout wrapper.
  - Validate security: no secrets in logs; timeout cannot be disabled to 0.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: fast success, slow-then-timeout, transient 5xx retry, breaker-open short-circuit.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(stellar): add per-request timeout and bounded retry to RPC transport`

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
title: "Remove hardcoded default JWT_SECRET and DATABASE_URL from the secrets initializer"
labels: type:security, area:config, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Remove hardcoded default JWT_SECRET and DATABASE_URL from the secrets initializer

### Description
`initializeSecrets` in [`src/config/secrets.ts`](src/config/secrets.ts) registers `JWT_SECRET` with a literal fallback `'dev-secret-keep-it-safe'` and `DATABASE_URL` with `'postgresql://localhost:5432/talenttrust'`. Because `EnvSecret` only throws when *no* default is supplied, a production deploy that forgets to set `JWT_SECRET` will silently sign and verify tokens with a publicly-known secret committed to source — anyone can mint valid JWTs. This issue makes these secrets required outside development.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Register `JWT_SECRET` and `DATABASE_URL` without a literal fallback when `NODE_ENV` is not `development`/`test`, so `EnvSecret.load()` throws the existing "Missing required secret" error at boot.
- Enforce a minimum `JWT_SECRET` length and reject the known weak literal even if explicitly set.
- Keep developer ergonomics: a clearly-labelled dev-only default is acceptable only under `development`.
- Never log the secret value; route any diagnostics through [`src/logger.ts`](src/logger.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/secrets-no-hardcoded-jwt-default`
- Implement changes
  - **Write code in:** [`src/config/secrets.ts`](src/config/secrets.ts).
  - **Write comprehensive tests in:** create `src/config/secrets.test.ts` — assert boot fails in production without the secret, dev default still works, and the weak literal is rejected.
  - **Add documentation:** update [`docs/backend/secrets-handling.md`](docs/backend/secrets-handling.md) and [`.env.example`](.env.example).
  - Add TSDoc explaining the fail-fast rationale.
  - Validate security: no weak fallback reachable in production.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: missing in prod, present, weak literal, short secret, dev mode.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(security): require JWT_SECRET and DATABASE_URL in production`

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
title: "Implement a real HTTP probe in the deployment validator's performHealthCheck"
labels: type:feature, area:deployment, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Implement a real HTTP probe in the deployment validator's performHealthCheck

### Description
`performHealthCheck(baseUrl)` in [`src/deployment/validator.ts`](src/deployment/validator.ts) never contacts the service: its comment says "In a real implementation, this would make an HTTP request / For now, we'll simulate a successful health check," and it returns `{ status: 'healthy' }` with a meaningless `responseTime` (start/end measured around zero work). Any caller validating deployment readiness through this function gets a green light regardless of the target's true state. This issue makes the probe actually call the target's readiness endpoint.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Implement `performHealthCheck` to GET the target's `/health/ready` endpoint (served by [`src/health/router.ts`](src/health/router.ts)) with a bounded timeout and report `unhealthy` on non-200, network error, or timeout.
- Validate `baseUrl` with the SSRF guard in [`src/utils/ssrf.ts`](src/utils/ssrf.ts) so the probe cannot be aimed at arbitrary internal hosts.
- Record an accurate `responseTime` measured around the real request and keep the existing `HealthCheckResult` shape consumed by `validateDeploymentReadiness`.
- Make the HTTP call injectable so tests avoid real network access.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/deployment-validator-real-probe`
- Implement changes
  - **Write code in:** [`src/deployment/validator.ts`](src/deployment/validator.ts).
  - **Write comprehensive tests in:** create `src/deployment/validator.test.ts` — mock the HTTP client; assert healthy 200, 503 unhealthy, connection refused, timeout, and SSRF rejection.
  - **Add documentation:** update [`docs/backend/deployment-guide.md`](docs/backend/deployment-guide.md).
  - Add TSDoc to the probe.
  - Validate security: SSRF guard applied; no internal detail leaked.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: 200, 503, refused, timeout, invalid/internal URL.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`feat(deployment): make performHealthCheck probe the target readiness endpoint`

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
title: "Add a real notification email transport to replace the console-only fallback"
labels: type:feature, area:notifications, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a real notification email transport to replace the console-only fallback

### Description
`ConsoleTransport` in [`src/services/notification.transport.ts`](src/services/notification.transport.ts) is the default `NotificationTransport`: its `sendEmail` only `console.log`s the recipient and returns `{ success: true }`, and `sendWebNotification` does the same. Only `WebhookTransport` is a real implementation — there is no concrete email provider, so any notification flow that resolves to the default transport silently drops mail while reporting success. This issue adds a real, injectable SMTP/provider email transport implementing the existing `NotificationTransport` interface.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a concrete email transport (SMTP/SES/SendGrid) implementing `NotificationTransport.sendEmail`, selected from validated config in [`src/config/env.schema.ts`](src/config/env.schema.ts).
- Surface provider failures so `NotificationResult.success` is `false` (and callers can retry) rather than always-true.
- Validate `EmailPayload.to` and guard against header injection before dispatch; keep `ConsoleTransport` as the explicit dev/test default.
- Do not log full recipient addresses at info level; route through [`src/logger.ts`](src/logger.ts) and reuse redaction from [`src/utils/redact.ts`](src/utils/redact.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/notification-email-transport`
- Implement changes
  - **Write code in:** [`src/services/notification.transport.ts`](src/services/notification.transport.ts) and wiring in [`src/services/notification.service.ts`](src/services/notification.service.ts).
  - **Write comprehensive tests in:** create `src/services/notification.transport.test.ts` — mock the provider; assert delivery, failure propagation, recipient validation, and header-injection rejection.
  - **Add documentation:** update [`docs/notifications.md`](docs/notifications.md).
  - Add TSDoc to the new transport.
  - Validate security: header-injection guard; no PII in logs.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: valid send, provider throws, invalid recipient, injected header, missing config.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(notifications): add a real email transport behind the transport interface`

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
title: "Generate collision-resistant notification ids in the webhook transport"
labels: type:enhancement, area:notifications, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Generate collision-resistant notification ids in the webhook transport

### Description
`WebhookTransport.sendWebNotification` in [`src/services/notification.transport.ts`](src/services/notification.transport.ts) builds the delivery id as `` `${payload.userId}:${Date.now()}` ``. Two notifications for the same user within the same millisecond produce an identical id, which collides with the idempotency/dedupe keys downstream in webhook delivery and can suppress a legitimate second notification. This issue switches id generation to a crypto-strong unique source.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace the `userId:Date.now()` id with `crypto.randomUUID()` (optionally prefixed with `userId` for readability) so ids are unique under rapid succession.
- Preserve the `NotificationResult` shape and the `webhookService.send` call contract.
- Ensure the id remains stable for a single logical send (do not regenerate on retry within the same `send`).
- Add a focused regression assertion that rapid successive sends for one user produce distinct ids.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/notification-strong-ids`
- Implement changes
  - **Write code in:** [`src/services/notification.transport.ts`](src/services/notification.transport.ts).
  - **Write comprehensive tests in:** create `src/services/notification.transport.test.ts` (or extend the suite added for the email transport) — assert uniqueness across rapid calls and stable id on retry.
  - **Add documentation:** note the id scheme in the module TSDoc and [`docs/notifications.md`](docs/notifications.md).
  - Add TSDoc to the id helper.
  - Validate: no id reuse within the same millisecond.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: 1000 rapid sends for one user, retry path, distinct users.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(notifications): use crypto-strong unique ids in webhook transport`

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
title: "Guard the SSRF allowlist bypass so dev/test never leaks into production"
labels: type:security, area:security, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Guard the SSRF allowlist bypass so dev/test never leaks into production

### Description
`isSafeUrl` in [`src/utils/ssrf.ts`](src/utils/ssrf.ts) short-circuits to `return true` whenever `NODE_ENV` is `development` or `test`, disabling all private-IP and metadata-endpoint checks. If `NODE_ENV` is ever unset, misspelled, or left as a non-`production` value in a deployed environment, the bypass does not trigger but neither does any positive assertion that protection is on — there is no fail-closed default and no explicit, auditable opt-in. This issue tightens the bypass to a deliberate, narrowly-scoped flag and adds IPv6/embedded-IPv4 coverage to the blocklist.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace the implicit `NODE_ENV` bypass with an explicit, default-off allow flag (e.g. `SSRF_ALLOW_PRIVATE_HOSTS`) that is rejected outright when `NODE_ENV==='production'`.
- Extend `isPrivateHost` to cover IPv6 loopback/ULA (`::1`, `fc00::/7`), IPv4-mapped IPv6, and decimal/octal-encoded IPv4 that currently bypass the string-prefix check.
- Fail closed: any unparseable host or unknown environment must be treated as unsafe.
- Keep the existing function signatures so current callers ([`src/deploy.ts`](src/deploy.ts), RPC, webhook) need no changes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/ssrf-bypass-hardening`
- Implement changes
  - **Write code in:** [`src/utils/ssrf.ts`](src/utils/ssrf.ts).
  - **Write comprehensive tests in:** create `src/utils/ssrf.test.ts` — assert private IPv4/IPv6, encoded-IP bypass attempts, metadata endpoint, and that production ignores the allow flag.
  - **Add documentation:** update [`docs/backend/security.md`](docs/backend/security.md) with the flag semantics.
  - Add TSDoc to the new flag handling.
  - Validate security: no path returns true for a private host in production.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: `::1`, `0177.0.0.1`, `2130706433`, `[::ffff:127.0.0.1]`, unset NODE_ENV.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(security): harden SSRF bypass and add IPv6/encoded-IP coverage`

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
title: "Persist the retention manager's in-memory storage provider to SQLite"
labels: type:feature, area:retention, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Persist the retention manager's in-memory storage provider to SQLite

### Description
The `DataRetentionManager` in [`src/retention/index.ts`](src/retention/index.ts) defaults to an `InMemoryStorageProvider` from [`src/retention/storage.ts`](src/retention/storage.ts), so archived records, retention state, and the data backing `listArchivedData`/`getArchiveStats` live only in a process-local `Map`. A restart or blue-green switch wipes the entire archival inventory, which breaks compliance reporting and any purge decision that depends on knowing what was archived. This issue adds a durable SQLite-backed storage provider.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Implement a `SqliteStorageProvider` satisfying the storage interface in [`src/retention/storage.ts`](src/retention/storage.ts), using the existing connection from [`src/db/database.ts`](src/db/database.ts) and a migration in [`src/db/migrations.ts`](src/db/migrations.ts).
- Default `DataRetentionManager` to the persistent provider outside tests; keep `InMemoryStorageProvider` injectable for unit tests.
- Preserve the `RetainedData` shape from [`src/retention/types.ts`](src/retention/types.ts) and the policies in [`src/retention/policies.ts`](src/retention/policies.ts); support bounded/paginated reads.
- Ensure writes are transactional and survive restart.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/retention-sqlite-storage-provider`
- Implement changes
  - **Write code in:** [`src/retention/storage.ts`](src/retention/storage.ts) and [`src/retention/index.ts`](src/retention/index.ts).
  - **Write comprehensive tests in:** [`src/retention/retention.test.ts`](src/retention/retention.test.ts) — assert records survive a simulated restart and stats match persisted rows.
  - **Add documentation:** update [`docs/DATA_RETENTION.md`](docs/DATA_RETENTION.md) with the storage backend.
  - Add TSDoc to the provider.
  - Validate: no data loss across reopen; pagination bounds enforced.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty store, large archive pagination, reopen persistence, mixed storage types.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(retention): add SQLite-backed storage provider`

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
title: "Persist the in-memory DLQ store so failed webhooks survive restarts"
labels: type:feature, area:dlq, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Persist the in-memory DLQ store so failed webhooks survive restarts

### Description
[`src/dlqStore.ts`](src/dlqStore.ts) backs the dead-letter queue with an in-process array, so every failed webhook delivery captured for later replay is lost on process exit or a blue-green switch. Operators replaying via the DLQ endpoints in [`src/api/jobs.ts`](src/api/jobs.ts) silently lose entries that were enqueued by the previous process. This issue moves the DLQ to durable SQLite storage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Back the DLQ with SQLite via [`src/db/database.ts`](src/db/database.ts) and a migration in [`src/db/migrations.ts`](src/db/migrations.ts), preserving the current `dlqStore` public API so callers in [`src/api/jobs.ts`](src/api/jobs.ts) and [`src/queue/webhook-dlq.ts`](src/queue/webhook-dlq.ts) are unchanged.
- Store enqueue timestamp, provider, attempt count, and redacted payload (reuse [`src/utils/redact.ts`](src/utils/redact.ts)); never store raw signing secrets.
- Keep an optional bounded capacity with a documented eviction policy.
- Support reads after restart so replay sees previously-enqueued entries.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/dlq-sqlite-persistence`
- Implement changes
  - **Write code in:** [`src/dlqStore.ts`](src/dlqStore.ts).
  - **Write comprehensive tests in:** create `src/dlqStore.test.ts` — assert enqueue/list survive a simulated reopen and payloads are redacted at rest.
  - **Add documentation:** update [`docs/WEBHOOK-DLQ.md`](docs/WEBHOOK-DLQ.md).
  - Add TSDoc to the persistence layer.
  - Validate security: no secrets persisted in cleartext.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty DLQ, capacity eviction, reopen persistence, concurrent enqueue.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`feat(dlq): persist dead-letter entries in SQLite`

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
title: "Add a Redis-backed shared store option to the token-bucket rate limiter"
labels: type:feature, area:rate-limit, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a Redis-backed shared store option to the token-bucket rate limiter

### Description
`TokenBucketLimiter` in [`src/rateLimit.ts`](src/rateLimit.ts) holds bucket state in a per-process `Map`; its own docs note that "in a blue/green or multi-replica deployment each process maintains its own independent bucket state." With N replicas a provider can effectively send N× its intended rate, undermining the pacing guarantee for slow partners. This issue adds an optional shared backing store so the limit is enforced cluster-wide.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Introduce a `BucketStore` abstraction with the existing in-process `Map` as the default and a Redis-backed implementation selected via validated config in [`src/config/env.schema.ts`](src/config/env.schema.ts).
- Implement token refill/consume atomically in Redis (e.g. Lua/`MULTI`) so concurrent replicas cannot over-issue tokens.
- Keep `acquireToken`/`getTokenCount`/`getQueueDepth` semantics and the `redactId` log redaction unchanged; never store provider secrets.
- Fall back cleanly to in-process mode when Redis is unconfigured, documenting the trade-off.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/rate-limit-redis-store`
- Implement changes
  - **Write code in:** [`src/rateLimit.ts`](src/rateLimit.ts).
  - **Write comprehensive tests in:** create `src/rateLimit.test.ts` — fake timers + mock Redis; assert atomic consume, cross-instance enforcement, and in-process fallback.
  - **Add documentation:** update [`docs/request-limits-implementation.md`](docs/request-limits-implementation.md) with the upgrade path.
  - Add TSDoc to the `BucketStore` interface.
  - Validate security: only opaque provider IDs in store keys/logs.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: burst over capacity, two instances sharing a bucket, Redis down fallback.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(rate-limit): add optional Redis-backed bucket store`

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
title: "Bound the token-bucket queue depth to prevent unbounded waiter accumulation"
labels: type:enhancement, area:rate-limit, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Bound the token-bucket queue depth to prevent unbounded waiter accumulation

### Description
In [`src/rateLimit.ts`](src/rateLimit.ts), `acquireToken` pushes every throttled caller onto `bucket.queue` with no upper bound. A provider that is persistently slower than its refill rate accumulates waiters indefinitely — each holding an unresolved promise and its captured closure — which is an unbounded-memory / backpressure failure mode. This issue caps queue depth and applies a defined policy when the cap is hit.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a configurable max queue depth per provider (validated alongside `WEBHOOK_BUCKET_CAPACITY`/`WEBHOOK_REFILL_RATE_PER_SEC` in `loadRateLimiterConfig`).
- When the cap is exceeded, reject with a typed error (so the caller can route the delivery to the DLQ) rather than queueing forever.
- Record the rejection via the metrics module ([`src/webhookMetrics.ts`](src/webhookMetrics.ts) / [`src/utils/webhookMetrics.ts`](src/utils/webhookMetrics.ts)) without raising label cardinality.
- Preserve FIFO ordering and existing pacing for queues below the cap.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/rate-limit-queue-cap`
- Implement changes
  - **Write code in:** [`src/rateLimit.ts`](src/rateLimit.ts).
  - **Write comprehensive tests in:** create `src/rateLimit.test.ts` — fake timers; assert below-cap queues drain FIFO and over-cap acquisitions reject with the typed error.
  - **Add documentation:** update [`docs/request-limits-implementation.md`](docs/request-limits-implementation.md).
  - Add TSDoc to the cap config.
  - Validate: no unbounded growth; rejection is deterministic.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: exactly-at-cap, one-over-cap, drain-then-refill, single fast provider.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(rate-limit): cap per-provider queue depth with reject-on-overflow`

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
title: "Protect the circuit breaker reset() method behind an authenticated admin route"
labels: type:security, area:circuit-breaker, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Protect the circuit breaker reset() method behind an authenticated admin route

### Description
[`src/circuit-breaker/CircuitBreaker.ts`](src/circuit-breaker/CircuitBreaker.ts) documents that "the `reset()` method is intended for admin/test use only; in production it should be protected behind an authenticated admin route." Today nothing enforces that — any route or module with a breaker reference can force a tripped breaker back to CLOSED, defeating the protection that was tripping for a reason. This issue exposes reset only through an authenticated admin endpoint with an audit trail.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add an admin-guarded endpoint that resets a named breaker via the registry in [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts), protected by the admin guard in [`src/middleware/adminAuthGuard.ts`](src/middleware/adminAuthGuard.ts).
- Emit an audit entry (who reset which breaker, when) via [`src/audit/service.ts`](src/audit/service.ts).
- Reject unauthenticated/unauthorized callers with a safe error from [`src/errors/safeErrors.ts`](src/errors/safeErrors.ts); never expose internal breaker internals in the body.
- Keep `reset()` callable directly in tests without the HTTP layer.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/circuit-breaker-admin-reset`
- Implement changes
  - **Write code in:** a route under [`src/routes/admin.routes.ts`](src/routes/admin.routes.ts) and the registry in [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts).
  - **Write comprehensive tests in:** create `src/circuit-breaker/registry.test.ts` and a route integration test — assert reset requires admin auth and writes an audit record.
  - **Add documentation:** update [`docs/backend/circuit-breaker.md`](docs/backend/circuit-breaker.md).
  - Add TSDoc to the reset endpoint.
  - Validate security: 401/403 leak nothing; audit emitted on success.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: missing auth, wrong role, valid admin, unknown breaker name.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`feat(circuit-breaker): gate reset behind authenticated admin route with audit`

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
title: "Add a length guard before timingSafeEqual in contract metadata hash verification"
labels: type:security, area:contract-metadata, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a length guard before timingSafeEqual in contract metadata hash verification

### Description
The metadata hash verification in [`src/contractMetadata.ts`](src/contractMetadata.ts) lowercases the expected and fetched contract hashes and compares them, but `crypto.timingSafeEqual` throws a `RangeError` when the two buffers differ in length. A swapped contract whose hash differs in length therefore triggers an unhandled exception instead of a clean fail-closed rejection, and the throw path may surface internal detail. This issue adds an explicit equal-length guard so a mismatch is always a controlled rejection.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add an explicit length check before the constant-time compare; unequal lengths must short-circuit to a "not verified" result, never throw out of the verifier.
- Keep the comparison constant-time for equal-length inputs and preserve the existing fail-closed behaviour (reject on mismatch before any settlement/processing).
- Route any diagnostics through [`src/logger.ts`](src/logger.ts) without logging the raw hashes; emit a safe error via [`src/errors/safeErrors.ts`](src/errors/safeErrors.ts).
- Do not broaden what counts as a verified contract.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/contract-metadata-hash-length-guard`
- Implement changes
  - **Write code in:** [`src/contractMetadata.ts`](src/contractMetadata.ts).
  - **Write comprehensive tests in:** create `src/contractMetadata.test.ts` — assert equal-hash verify, mismatched-length reject (no throw), and mismatched-equal-length reject.
  - **Add documentation:** note the verification rule in [`docs/backend/contract-metadata-api.md`](docs/backend/contract-metadata-api.md).
  - Add TSDoc to the verifier.
  - Validate security: no RangeError escapes; no raw hash logged.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: identical, different-length, same-length-different, empty hash.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(security): guard hash length before timingSafeEqual in metadata verify`

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
title: "Validate the salt:hash format before splitting in API key verification"
labels: type:security, area:api-keys, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Validate the salt:hash format before splitting in API key verification

### Description
`verifyApiKey` in [`src/auth/apiKeys.ts`](src/auth/apiKeys.ts) splits the stored credential on `:` to recover the salt and hash before running PBKDF2. A stored value that is empty, missing the separator, or otherwise malformed (e.g. from a botched migration) yields `undefined` halves that flow into the crypto call, risking a thrown exception on the authentication hot path rather than a clean rejection. This issue validates the stored format up front and fails closed.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Validate that the stored credential is a well-formed `salt:hash` (both parts present, correct hex length) before calling PBKDF2; on malformed input, reject as an invalid key without throwing.
- Keep the existing salted PBKDF2 verification and timing-safe comparison as the source of truth for well-formed records.
- Do not log the stored hash or salt; surface a generic invalid-key result.
- Preserve the `ApiKeyInfo`/return shape and existing expiry/`last_used_at` behaviour.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/api-key-stored-format-validation`
- Implement changes
  - **Write code in:** [`src/auth/apiKeys.ts`](src/auth/apiKeys.ts).
  - **Write comprehensive tests in:** [`src/auth/__tests__/apiKeys.test.ts`](src/auth/__tests__/apiKeys.test.ts) — assert malformed stored values reject cleanly and valid keys still verify.
  - **Add documentation:** note the storage format in [`docs/api-keys.md`](docs/api-keys.md).
  - Add TSDoc to the validation helper.
  - Validate security: no throw on malformed input; constant-time compare preserved.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty string, no colon, extra colons, wrong-length hex, valid key.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(api-keys): validate stored salt:hash format before verification`

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
title: "Avoid leaking the raw secret value in EnvSecret transform error messages"
labels: type:security, area:config, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Avoid leaking the raw secret value in EnvSecret transform error messages

### Description
`EnvSecret.load()` in [`src/config/secrets.ts`](src/config/secrets.ts) wraps a failed `transform()` in `Configuration Error: Failed to transform secret "${key}": ${error.message}`. Because the `transform` callback receives the raw secret string, a thrown error inside it (e.g. a parser that echoes its input) can carry the secret value into the error message, which then propagates to startup logs/stack traces. This issue ensures transform failures never embed the secret value.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Catch transform failures and emit an error that names only the `key`, never the raw value or any substring of it; redact via [`src/utils/redact.ts`](src/utils/redact.ts) where helpful.
- Preserve the fail-fast contract (still throws) and the existing `Secret`/`EnvSecret`/`SecretsManager` API.
- Ensure the message is safe to log through [`src/logger.ts`](src/logger.ts).
- Cover both string and non-Error throws from `transform`.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/envsecret-transform-error-redaction`
- Implement changes
  - **Write code in:** [`src/config/secrets.ts`](src/config/secrets.ts).
  - **Write comprehensive tests in:** create `src/config/secrets.test.ts` (or extend it) — assert a transform that includes the raw value never leaks it into the thrown message.
  - **Add documentation:** note the guarantee in [`docs/backend/secrets-handling.md`](docs/backend/secrets-handling.md).
  - Add TSDoc to the error path.
  - Validate security: no secret substring in any thrown/logged message.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: transform throws Error with value, throws string, throws non-Error, succeeds.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(security): never embed raw secret values in EnvSecret errors`

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
title: "Support asynchronous secret rotation backends in the SecretsManager"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Support asynchronous secret rotation backends in the SecretsManager

### Description
`EnvSecret.refresh()` in [`src/config/secrets.ts`](src/config/secrets.ts) only re-reads `process.env`, and its TSDoc notes that "in a production environment with rotation (like AWS Secrets Manager), this would involve an asynchronous API call to fetch the latest version." There is no concrete rotating `Secret` implementation, so `SecretsManager.refreshAll()` is effectively a no-op for real rotation. This issue adds a pluggable async secret source so secrets can rotate without a restart.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a `RotatingSecret` implementation of the existing `Secret<T>` interface that fetches from an injectable async provider with a cached value and a configurable refresh interval.
- Keep the synchronous `get()` contract (serve the last fetched value) and make `refresh()` perform the real async fetch; integrate cleanly with `SecretsManager.refreshAll()`.
- Never log fetched secret values; reuse redaction and fail safe (retain the prior value) on a refresh error.
- Document how to register a rotating secret alongside `EnvSecret`.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/secrets-rotating-source`
- Implement changes
  - **Write code in:** [`src/config/secrets.ts`](src/config/secrets.ts).
  - **Write comprehensive tests in:** create `src/config/secrets.test.ts` — mock the async provider; assert initial fetch, refresh updates value, and refresh failure retains the prior value.
  - **Add documentation:** update [`docs/backend/secrets-handling.md`](docs/backend/secrets-handling.md).
  - Add TSDoc to `RotatingSecret`.
  - Validate security: no secret value in logs; old value retained on error.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: initial load, successful rotation, provider error, refreshAll across mixed sources.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`feat(config): add async rotating secret source to SecretsManager`

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
title: "Route swrCache background revalidation errors through the structured logger"
labels: type:enhancement, area:utils, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Route swrCache background revalidation errors through the structured logger

### Description
`SWRCache` in [`src/utils/swrCache.ts`](src/utils/swrCache.ts) swallows background revalidation failures with a single `console.error`, and a comment notes "depending on error handling policy, we could log this explicitly." Silent `console.error` means a key that fails to revalidate keeps serving stale data with no aggregatable signal — operators cannot alert on a wedged cache. This issue routes the failure through structured logging and an optional callback.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace the `console.error` with a structured log via [`src/logger.ts`](src/logger.ts) including the cache key and error, redacted via [`src/utils/redact.ts`](src/utils/redact.ts).
- Add an optional `onRevalidationError` callback hook so consumers can increment a metric; keep the swallow-and-serve-stale behaviour (callers must never see the background error).
- Do not change fresh/stale/miss/coalescing semantics; behaviour-preserving except logging.
- Keep timers clean (no leaked handles) so tests remain deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/swrcache-structured-error-logging`
- Implement changes
  - **Write code in:** [`src/utils/swrCache.ts`](src/utils/swrCache.ts).
  - **Write comprehensive tests in:** create `src/utils/swrCache.test.ts` — fake timers; assert revalidation error logs structured, fires the callback, and callers still get stale value.
  - **Add documentation:** add usage notes in the `SWRCache` TSDoc.
  - Add TSDoc to the callback hook.
  - Validate: no error propagates to callers; no leaked timers.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: revalidation throws, succeeds, concurrent miss coalescing, callback omitted.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(utils): log SWR revalidation errors via structured logger and callback`

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
title: "Add max-entry eviction to the in-memory SWR cache to bound memory"
labels: type:enhancement, area:utils, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add max-entry eviction to the in-memory SWR cache to bound memory

### Description
`SWRCache` in [`src/utils/swrCache.ts`](src/utils/swrCache.ts) stores entries in an unbounded `Map`; keys are only ever added, never evicted beyond their TTL/staleness role. A high-cardinality key space (e.g. per-user or per-contract cache keys) grows the map without limit, leaking memory over the life of the process. This issue adds a bounded-capacity eviction policy.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a configurable `maxEntries` with an LRU (or insertion-order) eviction so the map never exceeds the cap.
- Eviction must not break in-flight coalesced revalidation for a still-referenced key.
- Preserve the fresh/stale/miss semantics and the existing constructor options; default to a sane cap.
- Expose the current size for observability/testing.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/swrcache-bounded-eviction`
- Implement changes
  - **Write code in:** [`src/utils/swrCache.ts`](src/utils/swrCache.ts).
  - **Write comprehensive tests in:** create `src/utils/swrCache.test.ts` (or extend it) — assert eviction at cap, LRU ordering, and that an in-flight revalidation is not corrupted by eviction.
  - **Add documentation:** document `maxEntries` in the `SWRCache` TSDoc and [`docs/backend/caching.md`](docs/backend/caching.md).
  - Add TSDoc to the eviction logic.
  - Validate: size never exceeds cap; no stale-pointer bug.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: cap of 1, eviction during revalidation, repeated access reorders LRU.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(utils): add bounded LRU eviction to SWR cache`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
