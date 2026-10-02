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