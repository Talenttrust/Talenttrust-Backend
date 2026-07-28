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
++++++
---
type: Feature
title: "Add unit tests for the AppError class and safe error serialization"
labels: type:test, area:errors, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the AppError class and safe error serialization

### Description
The error layer in [`src/errors/appError.ts`](src/errors/appError.ts) (custom `AppError` with status codes) and [`src/errors/safeErrors.ts`](src/errors/safeErrors.ts) (safe client-facing serialization) is the gate that decides what error detail reaches API clients, yet neither has a dedicated test file. Untested serialization is exactly where internal stack traces or messages leak. This issue adds focused coverage for both.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- For `AppError`: assert status code, name, and that it is an `instanceof Error`/`AppError` and serializes its public fields.
- For `safeErrors`: assert known `AppError`s map to their declared status/message, unknown errors map to a generic 500 with no internal detail, and stack traces never appear in the output.
- Assert no sensitive substring (paths, secrets) survives serialization.
- Keep tests independent of any HTTP layer (unit-level).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/errors-apperror-safeerrors`
- Implement changes
  - **Write comprehensive tests in:** create `src/errors/appError.test.ts` and `src/errors/safeErrors.test.ts`.
  - **Write code in:** none expected beyond minimal test seams.
  - **Add documentation:** note covered behaviour in [`docs/backend/error-message-policy.md`](docs/backend/error-message-policy.md).
  - Add TSDoc to shared test helpers.
  - Validate security: no internal detail in serialized output.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: known AppError, unknown error, error with stack, error with sensitive message.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(errors): cover AppError and safe error serialization`

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
title: "Add unit tests for the SSRF protection utility"
labels: type:test, area:security, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the SSRF protection utility

### Description
[`src/utils/ssrf.ts`](src/utils/ssrf.ts) (`isPrivateHost`, `isSafeUrl`) is a security control guarding outbound requests from the deploy health checker, RPC client, and webhook delivery, but it has no dedicated test file. Its private-IP prefix list, hostname blocklist, and the `NODE_ENV` dev/test bypass are all unverified, so a regression that opens the guard would go unnoticed. This issue adds focused coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert `isPrivateHost` returns true for each documented private prefix and hostname and false for public hosts.
- Assert `isSafeUrl` rejects private hosts, metadata endpoints, and unparseable URLs in a production-like `NODE_ENV`, and that the dev/test bypass behaves exactly as documented.
- Drive `NODE_ENV` deterministically (save/restore) so tests do not leak environment state.
- No real network access.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/ssrf-utility-coverage`
- Implement changes
  - **Write comprehensive tests in:** create `src/utils/ssrf.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** note the covered scenarios in [`docs/backend/security.md`](docs/backend/security.md).
  - Add TSDoc to shared fixtures.
  - Validate security: no false negatives for private hosts in prod-like env.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: each private prefix, localhost, 169.254.x, public host, malformed URL, dev bypass.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(security): add coverage for the SSRF protection utility`

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
title: "Add unit tests for the HMAC webhook signing utility"
labels: type:test, area:webhooks, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the HMAC webhook signing utility

### Description
[`src/utils/webhook-signing.util.ts`](src/utils/webhook-signing.util.ts) generates and verifies HMAC-SHA256 signatures for outbound/inbound webhooks. There is a fuzz harness ([`src/utils/webhook-signing.fuzz.ts`](src/utils/webhook-signing.fuzz.ts)) but no deterministic unit test asserting the sign/verify contract, constant-time comparison, and rejection of tampered inputs. Untested signing is a high-impact gap since it is the trust boundary for webhook authenticity. This issue adds focused, deterministic coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert a signature produced by the signer verifies, and any single-bit tamper of body/signature/secret fails verification.
- Assert verification uses constant-time comparison and never throws on malformed/short signatures (returns false).
- Use fixed inputs/secrets so the suite is deterministic; do not assert real secret values in output.
- Cover empty body and wrong-length signature inputs.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/webhook-signing-util-coverage`
- Implement changes
  - **Write comprehensive tests in:** create `src/utils/webhook-signing.util.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/webhook-signature-verification.md`](docs/webhook-signature-verification.md).
  - Add TSDoc to shared fixtures.
  - Validate security: zero accepted forgeries; constant-time path exercised.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: valid, tampered body, tampered signature, wrong secret, empty body, short signature.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(webhooks): cover HMAC sign/verify utility`

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
title: "Add unit tests for the CircuitBreaker state machine and registry"
labels: type:test, area:circuit-breaker, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the CircuitBreaker state machine and registry

### Description
[`src/circuit-breaker/CircuitBreaker.ts`](src/circuit-breaker/CircuitBreaker.ts) implements the CLOSED → OPEN → HALF_OPEN state machine and [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts) tracks named breakers, but neither has a dedicated test file. The breaker guards the Stellar RPC path and is referenced by health probes, so its transition correctness and `getStats` accuracy directly affect availability decisions. This issue adds deterministic coverage of the full lifecycle.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert transitions: closed→open at `failureThreshold`, open rejects with `CircuitOpenError` (from [`src/circuit-breaker/errors.ts`](src/circuit-breaker/errors.ts)), open→half-open after `timeout`, half-open→closed on `successThreshold`, and half-open→open on failure.
- Assert `getStats()` reflects state, failure counts, and that `reset()` returns to CLOSED.
- Assert the registry returns the same instance per name and isolates distinct names.
- Use fake timers for the open→half-open window; deterministic, no real delays.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/circuit-breaker-state-machine`
- Implement changes
  - **Write comprehensive tests in:** create `src/circuit-breaker/CircuitBreaker.test.ts` and `src/circuit-breaker/registry.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/backend/circuit-breaker.md`](docs/backend/circuit-breaker.md).
  - Add TSDoc to shared test helpers.
  - Validate: deterministic timers; no leaked handles.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: threshold boundary, half-open success/failure, reset, two named breakers.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(circuit-breaker): cover state machine transitions and registry`

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
title: "Add unit tests for the deployment config and readiness validator"
labels: type:test, area:deployment, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the deployment config and readiness validator

### Description
`validateDeploymentConfig` and `validateDeploymentReadiness` in [`src/deployment/validator.ts`](src/deployment/validator.ts) enforce production-critical rules — port range, API base URL validity, "production must use mainnet," and "production CORS must not include wildcards or localhost" — but the module has no test file. A regression that weakens these checks would let an unsafe config deploy unnoticed. This issue adds focused coverage of the validation matrix.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert each error branch: invalid port, invalid API base URL, production+non-mainnet, production CORS wildcard/localhost.
- Assert each warning branch: debug-in-production, staging-on-mainnet.
- Assert `validateDeploymentReadiness` returns early when config validation fails and otherwise passes through.
- Use a typed `EnvironmentConfig` fixture builder so cases are explicit and isolated.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/deployment-validator-config`
- Implement changes
  - **Write comprehensive tests in:** create `src/deployment/validator.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/backend/deployment-guide.md`](docs/backend/deployment-guide.md).
  - Add TSDoc to the fixture builder.
  - Validate: every error/warning branch is asserted.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: valid prod, each invalid prod rule, staging warning, debug warning, bad port/url.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(deployment): cover config and readiness validation rules`

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
title: "Add unit tests for the reputation service score aggregation"
labels: type:test, area:reputation, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the reputation service score aggregation

### Description
[`src/services/reputation.service.ts`](src/services/reputation.service.ts) computes freelancer reputation scores and is the aggregation reused by both the on-demand controller and the bulk recompute processor, yet it has no dedicated test file. Scoring math that is wrong or non-deterministic silently corrupts every reputation surface. This issue adds focused, deterministic coverage of the aggregation logic.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert score computation for representative rating distributions (all-positive, all-negative, mixed, single rating) using a mocked [`src/repositories/reputationRepository.ts`](src/repositories/reputationRepository.ts).
- Assert the empty-ratings case yields a defined default rather than `NaN`/throw, and that ordering of inputs does not change the result.
- Assert rounding/precision behaviour is stable and bounded to the documented range.
- Keep tests pure (no DB), with a repository stub.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/reputation-service-aggregation`
- Implement changes
  - **Write comprehensive tests in:** create `src/services/reputation.service.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/reputation-scoring.md`](docs/reputation-scoring.md).
  - Add TSDoc to shared fixtures.
  - Validate: no `NaN`/throw on empty input; deterministic ordering.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: empty, single, all-positive, all-negative, mixed, input reordering.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(reputation): cover score aggregation in reputation service`

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
title: "Add concurrency-safety tests for the reputation scheduler service"
labels: type:test, area:reputation, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test concurrency safety of the reputation scheduler service

### Description
[`src/services/reputation-scheduler.service.ts`](src/services/reputation-scheduler.service.ts) schedules periodic reputation recompute, but has no test file. If a scheduled tick can fire while a previous recompute is still running, two concurrent recomputes can race on the checkpoint in [`src/models/reputation-checkpoint.store.ts`](src/models/reputation-checkpoint.store.ts) and produce inconsistent results. This issue verifies the scheduler does not overlap runs and handles a failing run cleanly.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert a single in-flight recompute prevents an overlapping run when the timer fires again (no concurrent execution).
- Assert a recompute that throws does not wedge the scheduler (next tick still runs) and is logged via [`src/logger.ts`](src/logger.ts).
- Assert start/stop is idempotent and leaves no dangling timers.
- Use fake timers; mock the recompute path so tests are deterministic and DB-free.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/reputation-scheduler-concurrency`
- Implement changes
  - **Write comprehensive tests in:** create `src/services/reputation-scheduler.service.test.ts`.
  - **Write code in:** add a minimal test seam only if needed to observe overlap.
  - **Add documentation:** cross-reference [`docs/backend/reputation-system.md`](docs/backend/reputation-system.md).
  - Add TSDoc to shared helpers.
  - Validate: no overlapping runs; no leaked timers.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: overlapping ticks, failing run then recovery, double start, stop mid-run.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(reputation): cover scheduler concurrency and failure recovery`

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
title: "Add unit tests for the audit service and SQLite audit repository"
labels: type:test, area:audit, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the audit service and SQLite audit repository

### Description
[`src/audit/service.ts`](src/audit/service.ts) records audit events and [`src/audit/sqliteRepository.ts`](src/audit/sqliteRepository.ts) persists them, but neither has a dedicated test file. The audit trail is the system of record for who did what (key resets, deploy actions, sensitive reads), so untested persistence risks silently dropping records or storing unredacted detail. This issue adds focused coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- For the service: assert an audit entry is built with action, actor, timestamp, and correlation id and routed to the repository; assert sensitive fields are redacted via [`src/audit/redact.ts`](src/audit/redact.ts).
- For the SQLite repository: assert write-then-read round-trips a record and that queries/filters return expected rows using an in-memory SQLite instance.
- Assert a repository write failure surfaces (not silently swallowed) without crashing the request path.
- Keep tests deterministic and DB-isolated.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/audit-service-sqlite-repo`
- Implement changes
  - **Write comprehensive tests in:** create `src/audit/service.test.ts` and `src/audit/sqliteRepository.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/backend/audit-log.md`](docs/backend/audit-log.md).
  - Add TSDoc to shared fixtures.
  - Validate security: no unredacted sensitive field persisted.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: write+read round-trip, redaction, filter query, write failure.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(audit): cover audit service and SQLite repository`

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
title: "Add CSV/JSON export integration tests for the audit export service"
labels: type:test, area:audit, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the audit trail export service

### Description
[`src/audit/exportService.ts`](src/audit/exportService.ts) exports the audit trail (CSV/JSON) for compliance review, but has no test file. CSV export is a classic injection and quoting hazard (fields beginning with `=`/`+`/`-`/`@`, embedded commas/newlines), and broken JSON serialization quietly produces unusable compliance reports. This issue adds coverage for correct, safe serialization.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert JSON export round-trips records faithfully and CSV export quotes/escapes fields containing commas, quotes, and newlines.
- Assert CSV-injection-prone values (leading `=`,`+`,`-`,`@`) are neutralized (prefixed/escaped) so spreadsheets do not execute them.
- Assert empty datasets and large datasets stream/paginate without loading everything in memory if the service supports it.
- Use a seeded fixture set; no live audit DB dependency beyond an in-memory instance.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/audit-export-service`
- Implement changes
  - **Write comprehensive tests in:** create `src/audit/exportService.test.ts`.
  - **Write code in:** add a CSV-injection neutralizer if the export lacks one.
  - **Add documentation:** cross-reference [`docs/backend/audit-log.md`](docs/backend/audit-log.md).
  - Add TSDoc to the export helpers.
  - Validate security: no formula injection; correct CSV quoting.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: comma/quote/newline fields, formula-prefixed values, empty set, large set.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(audit): cover CSV/JSON export and CSV-injection safety`

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
title: "Add unit tests for the global error-handling middleware"
labels: type:test, area:errors, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the global error-handling middleware

### Description
[`src/middleware/errorHandlers.ts`](src/middleware/errorHandlers.ts) is the terminal Express error handler that maps thrown errors to client responses, yet it has no dedicated test file. This middleware is the last line of defense against leaking stack traces or internal messages, so its behaviour for `AppError`s, validation errors, and unknown errors must be verified. This issue adds isolated coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert an `AppError` (from [`src/errors/appError.ts`](src/errors/appError.ts)) maps to its status and safe message via [`src/errors/safeErrors.ts`](src/errors/safeErrors.ts).
- Assert an unknown error maps to a generic 500 with no internal detail/stack, and that the error is logged (redacted) via [`src/logger.ts`](src/logger.ts).
- Assert a correlation id (if present on the request) is echoed in the response for support traceability.
- Drive the handler with mock `req`/`res`/`next`; no live server.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/error-handler-middleware`
- Implement changes
  - **Write comprehensive tests in:** create `src/middleware/errorHandlers.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/backend/error-handling.md`](docs/backend/error-handling.md).
  - Add TSDoc to shared mocks.
  - Validate security: no stack/internal message in any response body.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: AppError, validation error, unknown error, correlation id present/absent.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(errors): cover global error-handling middleware`

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
title: "Add unit tests for the input sanitization middleware"
labels: type:test, area:security, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the input sanitization middleware

### Description
[`src/middleware/sanitize.ts`](src/middleware/sanitize.ts) sanitizes inbound request input (body/query/params) before it reaches handlers, but has no dedicated test file. Sanitization is a security control against injection/XSS-style payloads, and an untested regression here could silently let dangerous input through or, conversely, corrupt legitimate input. This issue adds focused coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert known dangerous patterns are neutralized in body, query, and params, while benign input passes through unchanged.
- Assert nested objects/arrays are sanitized recursively and that prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are stripped/rejected.
- Assert the middleware calls `next()` and does not mutate types unexpectedly (numbers/booleans preserved).
- Drive with mock `req`/`res`/`next`; no live server.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/sanitize-middleware-coverage`
- Implement changes
  - **Write comprehensive tests in:** create `src/middleware/sanitize.test.ts`.
  - **Write code in:** none expected beyond minimal seams (add a prototype-pollution guard if absent).
  - **Add documentation:** cross-reference [`docs/backend/security.md`](docs/backend/security.md).
  - Add TSDoc to shared fixtures.
  - Validate security: prototype-pollution keys cannot reach handlers.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: nested payload, prototype-pollution keys, benign types, empty input.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(security): cover input sanitization middleware`

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
title: "Add unit tests for pagination, sorting, filtering, and search query utilities"
labels: type:test, area:utils, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the query helper utilities (pagination, sorting, filtering, search)

### Description
The query helpers in [`src/utils/pagination.ts`](src/utils/pagination.ts), [`src/utils/sorting.ts`](src/utils/sorting.ts), [`src/utils/filtering.ts`](src/utils/filtering.ts), and [`src/utils/search.ts`](src/utils/search.ts) parse untrusted client query params into list-query parameters used across controllers, but none have test files. Unvalidated paging/sorting is both a correctness and an abuse risk (e.g. huge page sizes, sort on disallowed fields, injection via sort keys). This issue adds focused coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert pagination clamps page/limit to bounds and rejects/normalizes invalid values; defaults are applied for missing params.
- Assert sorting only accepts allow-listed fields and directions, rejecting arbitrary keys.
- Assert filtering and search correctly parse supported operators and ignore/escape unsupported or injection-prone input.
- Keep tests pure (no DB); cover boundary values.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/query-helpers-coverage`
- Implement changes
  - **Write comprehensive tests in:** create `src/utils/pagination.test.ts`, `src/utils/sorting.test.ts`, `src/utils/filtering.test.ts`, and `src/utils/search.test.ts`.
  - **Write code in:** add an allow-list/clamp guard only if one is missing.
  - **Add documentation:** cross-reference [`docs/backend/pagination.md`](docs/backend/pagination.md) and [`docs/backend/sorting-and-search.md`](docs/backend/sorting-and-search.md).
  - Add TSDoc to shared fixtures.
  - Validate security: sort/filter fields are allow-listed.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: over-limit page size, negative page, disallowed sort field, malformed filter, empty search.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(utils): cover pagination, sorting, filtering, and search helpers`

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
title: "Add ETag-based conditional request support to read-heavy list endpoints"
labels: type:enhancement, area:api, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add ETag-based conditional request support to read-heavy list endpoints

### Description
[`src/utils/etag.ts`](src/utils/etag.ts) provides ETag generation but it is not wired into the read-heavy contract/reputation list endpoints in [`src/routes/contracts.routes.ts`](src/routes/contracts.routes.ts) and [`src/routes/reputation.routes.ts`](src/routes/reputation.routes.ts). Without `If-None-Match` handling, clients re-download unchanged payloads every poll, wasting bandwidth and load. This issue adds conditional-request middleware that returns `304 Not Modified` when the ETag matches.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add middleware (or a response helper) that computes a stable ETag from the serialized list response via [`src/utils/etag.ts`](src/utils/etag.ts) and returns `304` when the client's `If-None-Match` matches.
- Apply to the contract and reputation list endpoints; do not change response bodies on a cache miss.
- Ensure the ETag is computed over the canonical body only (not volatile fields like timestamps) and is safe to expose.
- Keep it compatible with the existing pagination/sorting query helpers.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/etag-conditional-requests`
- Implement changes
  - **Write code in:** [`src/utils/etag.ts`](src/utils/etag.ts) and a small middleware wired in [`src/routes/contracts.routes.ts`](src/routes/contracts.routes.ts) / [`src/routes/reputation.routes.ts`](src/routes/reputation.routes.ts).
  - **Write comprehensive tests in:** create `src/utils/etag.test.ts` and a route integration test — assert matching `If-None-Match` yields 304 and a mismatch yields 200 with body.
  - **Add documentation:** update [`docs/API.md`](docs/API.md) with the caching contract.
  - Add TSDoc to the middleware.
  - Validate: ETag is deterministic for identical canonical bodies.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: match 304, mismatch 200, missing header, paginated variants.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(api): add ETag conditional requests to list endpoints`

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
title: "Expose a circuit-breaker status endpoint backed by the breaker registry"
labels: type:observability, area:circuit-breaker, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Expose a circuit-breaker status endpoint backed by the breaker registry

### Description
[`src/rpc/stellarClient.ts`](src/rpc/stellarClient.ts) references a `/api/v1/circuit-breaker/status` endpoint in its `getCircuitStats` doc comment, and [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts) already tracks named breakers — but no such read endpoint exists. Operators cannot see which upstreams are tripped without reading logs. This issue adds an admin-readable status endpoint enumerating all breakers and their state.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a `GET` status endpoint that returns each named breaker's state and stats from the registry in [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts).
- Protect it with the admin guard in [`src/middleware/adminAuthGuard.ts`](src/middleware/adminAuthGuard.ts) and return a safe body (no internal stack/host detail beyond state/counters).
- Do not mutate breaker state (read-only); pair with the existing metrics rather than duplicating them.
- Register the route in [`src/routes/admin.routes.ts`](src/routes/admin.routes.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b observability/circuit-breaker-status-endpoint`
- Implement changes
  - **Write code in:** [`src/routes/admin.routes.ts`](src/routes/admin.routes.ts) and a small handler using [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts).
  - **Write comprehensive tests in:** create a route integration test asserting auth, shape, and that distinct breaker states are reported.
  - **Add documentation:** update [`docs/backend/circuit-breaker.md`](docs/backend/circuit-breaker.md) and [`docs/backend/observability.md`](docs/backend/observability.md).
  - Add TSDoc to the handler.
  - Validate security: admin-only; read-only; safe body.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: no breakers, mixed states, unauthenticated caller, non-admin caller.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`feat(observability): add admin circuit-breaker status endpoint`

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
title: "Emit token-bucket queue-depth and token gauges to the metrics registry"
labels: type:observability, area:rate-limit, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Emit token-bucket queue-depth and token gauges to the metrics registry

### Description
`TokenBucketLimiter` in [`src/rateLimit.ts`](src/rateLimit.ts) exposes `getTokenCount` and `getQueueDepth` for observability, and `recordThrottled` increments a counter, but the live per-provider token level and queue backlog are never published as gauges. Operators can see throttle *events* but not the standing depth, so they cannot alert on a provider whose queue is growing. This issue publishes those gauges through the metrics service.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `webhook_rate_limit_queue_depth` and `webhook_rate_limit_tokens` gauges per provider, sampled on a bounded interval without blocking the delivery hot path.
- Register them on the existing registry in [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts); keep label cardinality bounded (use the truncated/redacted provider id from `redactId`).
- Do not change limiter behaviour; sampling must not consume tokens.
- Document scrape names and suggested alert thresholds.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b observability/rate-limit-gauges`
- Implement changes
  - **Write code in:** [`src/rateLimit.ts`](src/rateLimit.ts) and [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts).
  - **Write comprehensive tests in:** create `src/rateLimit.test.ts` (or extend) — assert gauge values track simulated queue/token state and reset when drained.
  - **Add documentation:** update [`docs/backend/observability.md`](docs/backend/observability.md).
  - Add TSDoc to the sampler.
  - Validate: bounded cardinality; sampling does not consume tokens.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty bucket, queued waiters, drained queue, many providers.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(observability): publish rate-limiter token and queue-depth gauges`

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
title: "Add unit tests for the idempotency request middleware"
labels: type:test, area:idempotency, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the idempotency request middleware

### Description
[`src/middleware/idempotency.ts`](src/middleware/idempotency.ts) handles the `Idempotency-Key` header and replays cached responses for retried requests, but has no dedicated test file. Idempotency is a correctness boundary for any state-changing request (a missing test here means a duplicate POST could double-process), and the interplay with the store in [`src/db/idempotencyStore.ts`](src/db/idempotencyStore.ts) is unverified. This issue adds focused coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert a first request with a key processes and caches the response; an identical retry returns the cached response without re-invoking the handler.
- Assert a reused key with a different payload is rejected with a safe `409` (no silent double-process).
- Assert requests without the header pass through unchanged and that the store ([`src/db/idempotencyStore.ts`](src/db/idempotencyStore.ts)) is exercised through a mock/in-memory instance.
- Drive with mock `req`/`res`/`next`; deterministic, DB-isolated.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/idempotency-middleware-coverage`
- Implement changes
  - **Write comprehensive tests in:** create `src/middleware/idempotency.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/IDEMPOTENCY-QUICK-REFERENCE.md`](docs/IDEMPOTENCY-QUICK-REFERENCE.md).
  - Add TSDoc to shared mocks.
  - Validate security: conflicting payload returns 409, never replays the wrong result.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: first request, identical retry, conflicting payload, no header, concurrent duplicates.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(idempotency): cover idempotency request middleware`

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
title: "Add unit tests for the metrics authentication middleware"
labels: type:test, area:observability, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the metrics authentication middleware

### Description
[`src/middleware/metricsAuth.ts`](src/middleware/metricsAuth.ts) guards the Prometheus metrics endpoint, but has no dedicated test file. An unprotected `/metrics` leaks internal topology, request volumes, and breaker/queue health to anyone, so the auth gate's correctness is security-relevant and currently unverified. This issue adds focused coverage.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert a request with valid credentials (token/key per the implementation) passes to the metrics handler and one without is rejected with a safe `401`/`403`.
- Assert credential comparison is constant-time and that no credential value is logged (route through [`src/logger.ts`](src/logger.ts)/[`src/utils/redact.ts`](src/utils/redact.ts)).
- Assert behaviour when the metrics auth secret is unconfigured matches the intended fail-closed/disabled policy.
- Drive with mock `req`/`res`/`next`; no live server.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/metrics-auth-middleware`
- Implement changes
  - **Write comprehensive tests in:** create `src/middleware/metricsAuth.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/backend/observability.md`](docs/backend/observability.md).
  - Add TSDoc to shared mocks.
  - Validate security: no credential leakage; constant-time compare.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: valid, missing, invalid credential, unconfigured secret.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(observability): cover metrics authentication middleware`

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
title: "Add deterministic tests for the deployment history store"
labels: type:test, area:deployment, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the deployment history store

### Description
[`src/deployment/historyStore.ts`](src/deployment/historyStore.ts) records promotion/rollback history that the promoter and deploy routes rely on for `getPromotionHistory`, but it has no dedicated test file. Wrong ordering, lost records, or an unbounded store would corrupt the deployment audit trail surfaced to operators. This issue adds focused coverage of the store's read/write and ordering behaviour.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert appended records are returned in the documented order (most-recent-first or chronological, per implementation) and that timestamps/from→to/actor/outcome round-trip.
- Assert any capacity/retention bound behaves as documented (oldest evicted, not silently lost mid-list).
- Assert an empty store returns `[]` and that reads do not mutate state.
- Keep tests deterministic; if persistence is involved, use an isolated/in-memory instance.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/deployment-history-store`
- Implement changes
  - **Write comprehensive tests in:** create `src/deployment/historyStore.test.ts`.
  - **Write code in:** none expected beyond minimal seams.
  - **Add documentation:** cross-reference [`docs/deploy.md`](docs/deploy.md).
  - Add TSDoc to shared fixtures.
  - Validate: ordering and bounds match documentation.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: empty, single, many, capacity bound, ordering.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(deployment): cover promotion history store ordering and bounds`

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
title: "Add fault-injection tests for the chaos policy module"
labels: type:test, area:resilience, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Test the chaos policy fault-injection module

### Description
[`src/chaos/chaosPolicy.ts`](src/chaos/chaosPolicy.ts) injects faults (latency/errors) for resilience testing, but has no dedicated test file. A chaos policy that can accidentally activate in production — or that does not actually inject when enabled in a chaos run — is itself a reliability risk. This issue adds deterministic coverage of the policy's enable gating and injection behaviour.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert the policy is a no-op unless explicitly enabled, and that it can never enable in `production` unless an explicit, documented flag is set.
- Assert injection probability/latency are honored deterministically by seeding/injecting the randomness source rather than relying on real `Math.random`.
- Assert error injection produces the expected typed error and latency injection respects the configured bound.
- Use fake timers for latency injection; no real delays.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/chaos-policy-coverage`
- Implement changes
  - **Write comprehensive tests in:** create `src/chaos/chaosPolicy.test.ts`.
  - **Write code in:** add a randomness/clock injection seam only if needed for determinism.
  - **Add documentation:** cross-reference [`docs/backend/chaos-testing.md`](docs/backend/chaos-testing.md).
  - Add TSDoc to the injected seams.
  - Validate: cannot activate in production without the explicit flag.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: disabled no-op, production guard, error injection, latency injection bound.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`test(resilience): cover chaos policy gating and injection`

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
title: "Document the circuit breaker and Stellar RPC client integration"
labels: type:docs, area:circuit-breaker, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Document the circuit breaker and Stellar RPC client integration

### Description
The breaker in [`src/circuit-breaker/CircuitBreaker.ts`](src/circuit-breaker/CircuitBreaker.ts), the registry in [`src/circuit-breaker/registry.ts`](src/circuit-breaker/registry.ts), and the `StellarClient` wrapper in [`src/rpc/stellarClient.ts`](src/rpc/stellarClient.ts) work together to protect upstream Stellar/Soroban calls, but [`docs/backend/circuit-breaker.md`](docs/backend/circuit-breaker.md) does not fully explain the state machine, thresholds, the `X-Circuit-Name` 503 header, or how to read/reset breakers. Integrators and operators lack a single reference. This issue completes that documentation.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Document the CLOSED/OPEN/HALF_OPEN state machine with `failureThreshold`/`successThreshold`/`timeout` semantics and a state diagram.
- Explain the `stellar-rpc` breaker configuration, the `X-Circuit-Name` response header, and how `StellarClient` routes calls through it.
- Document how to read breaker status and the admin-only reset path, cross-referencing the registry.
- Ensure documented thresholds match the constants in code.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/circuit-breaker-rpc-integration`
- Implement changes
  - **Write code in:** none beyond doc-only clarifying TSDoc.
  - **Write comprehensive tests in:** rely on existing/added breaker tests to confirm documented behaviour.
  - **Add documentation:** expand [`docs/backend/circuit-breaker.md`](docs/backend/circuit-breaker.md) and link it from [`docs/backend/SOROBAN_RPC.md`](docs/backend/SOROBAN_RPC.md).
  - Ensure documented constants match the code.
  - Validate: diagram and thresholds match implementation.
- Test and commit

### Test and commit
- Run `npm run lint` to ensure no drift.
- Cross-check documented thresholds against [`src/rpc/stellarClient.ts`](src/rpc/stellarClient.ts).
- Include notes in the PR confirming accuracy.

### Example commit message
`docs(circuit-breaker): document breaker state machine and RPC integration`

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
title: "Document the secrets handling and rotation model"
labels: type:docs, area:config, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Document the secrets handling and rotation model

### Description
The secrets layer in [`src/config/secrets.ts`](src/config/secrets.ts) defines a `Secret<T>` interface, an `EnvSecret` implementation, and a `SecretsManager` with `refreshAll()`, but [`docs/backend/secrets-handling.md`](docs/backend/secrets-handling.md) does not fully explain how secrets are registered, retrieved, refreshed, or rotated, nor which env vars are required versus defaulted. Without this, contributors reintroduce weak defaults or log secret values. This issue completes the secrets documentation.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Document the `Secret`/`EnvSecret`/`SecretsManager` model: registering, `getValue`, `refresh`/`refreshAll`, and the fail-fast "Missing required secret" behaviour.
- Enumerate the secrets registered in `initializeSecrets` (PORT, NODE_ENV, DATABASE_URL, JWT_SECRET), marking which must be set in production and which have dev-only defaults.
- Describe redaction guarantees (no secret values in logs/errors) and the recommended rotation procedure.
- Keep `.env.example` aligned; never include real values.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/secrets-handling-model`
- Implement changes
  - **Write code in:** none beyond doc-only clarifying TSDoc.
  - **Write comprehensive tests in:** rely on the secrets tests to confirm documented behaviour.
  - **Add documentation:** expand [`docs/backend/secrets-handling.md`](docs/backend/secrets-handling.md) and align [`.env.example`](.env.example).
  - Ensure documented defaults match the code.
  - Validate: no real secret values committed.
- Test and commit

### Test and commit
- Run `npm run lint` to ensure no drift.
- Cross-check documented defaults against [`src/config/secrets.ts`](src/config/secrets.ts).
- Include notes in the PR confirming accuracy.

### Example commit message
`docs(config): document secrets handling and rotation model`

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
title: "Refactor duplicate redaction implementations into a single shared helper"
labels: type:refactor, area:security, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Refactor duplicate redaction implementations into a single shared helper

### Description
There are at least four redaction implementations in the codebase — [`src/redact.ts`](src/redact.ts), [`src/utils/redact.ts`](src/utils/redact.ts), [`src/audit/redact.ts`](src/audit/redact.ts), and [`src/events/redact.ts`](src/events/redact.ts) — each maintaining its own sensitive-key list and masking logic. Divergent lists mean a secret redacted in one log path can leak in another, and fixes must be applied four times. This behaviour-preserving refactor consolidates them onto one canonical helper.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Pick one canonical redactor (e.g. [`src/utils/redact.ts`](src/utils/redact.ts)) with the union of all sensitive-key patterns and nested/array/Error-stack handling; re-export it from the other modules so call sites do not need sweeping edits.
- Preserve each existing call site's behaviour (no secret that was previously redacted may now leak); keep any audit-specific rules as configuration of the shared helper, not a separate implementation.
- Avoid over-redaction regressions (e.g. public keys/contract ids) and keep the function signatures stable.
- Deprecate the duplicate modules with a doc comment pointing to the canonical helper.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/consolidate-redaction-helpers`
- Implement changes
  - **Write code in:** [`src/utils/redact.ts`](src/utils/redact.ts), [`src/redact.ts`](src/redact.ts), [`src/audit/redact.ts`](src/audit/redact.ts), [`src/events/redact.ts`](src/events/redact.ts).
  - **Write comprehensive tests in:** create `src/utils/redact.test.ts` covering the union of patterns, nested/array/Error-stack cases, and no over-redaction of public keys/contract ids.
  - **Add documentation:** update [`docs/backend/logging-security.md`](docs/backend/logging-security.md).
  - Add TSDoc to the canonical helper.
  - Validate security: every previously-redacted pattern is still redacted everywhere.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: each module's prior patterns, nested objects, Error stacks, public-key false positives.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`refactor(security): consolidate redaction onto a single shared helper`

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
title: "Consolidate the duplicate rate-limit store implementations"
labels: type:refactor, area:rate-limit, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Consolidate the duplicate rate-limit store implementations

### Description
Rate limiting is implemented in multiple, overlapping places: the per-provider token bucket in [`src/rateLimit.ts`](src/rateLimit.ts), a separate in-memory store in [`src/lib/rateLimitStore.ts`](src/lib/rateLimitStore.ts), config in [`src/config/rateLimit.ts`](src/config/rateLimit.ts), and the request limiter middleware in [`src/middleware/rateLimiter.ts`](src/middleware/rateLimiter.ts). The duplicated in-memory stores drift in eviction and reset semantics and make it unclear which governs a given request. This behaviour-preserving refactor unifies the storage layer behind one interface.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Define a single rate-limit store interface and have both the middleware path ([`src/middleware/rateLimiter.ts`](src/middleware/rateLimiter.ts)) and the token-bucket path ([`src/rateLimit.ts`](src/rateLimit.ts)) consume it, removing the redundant [`src/lib/rateLimitStore.ts`](src/lib/rateLimitStore.ts) or making it the single implementation.
- Preserve current limits/headers/behaviour exactly; this is a structural consolidation, not a policy change.
- Centralize configuration through [`src/config/rateLimit.ts`](src/config/rateLimit.ts) so defaults live in one place.
- Document the unified model and the in-process vs shared-store trade-off.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/unify-rate-limit-stores`
- Implement changes
  - **Write code in:** [`src/lib/rateLimitStore.ts`](src/lib/rateLimitStore.ts), [`src/middleware/rateLimiter.ts`](src/middleware/rateLimiter.ts), [`src/config/rateLimit.ts`](src/config/rateLimit.ts).
  - **Write comprehensive tests in:** create `src/lib/rateLimitStore.test.ts` and extend middleware tests — assert identical limit behaviour before/after.
  - **Add documentation:** update [`docs/backend/RATE_LIMITING.md`](docs/backend/RATE_LIMITING.md).
  - Add TSDoc to the unified store interface.
  - Validate: no behavioural change in enforced limits.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: at-limit, over-limit, window reset, multiple keys.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`refactor(rate-limit): unify rate-limit stores behind one interface`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.
