---
type: Feature
title: "Add a bounded request timeout to outbound webhook axios.post calls"
labels: type:security, area:webhooks, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add a bounded request timeout to outbound webhook axios.post calls

### Description
`WebhookService.send` in [`src/services/webhook.service.ts`](src/services/webhook.service.ts) delivers each webhook with `await axios.post(payload.url, payload.data, { headers })` and **no `timeout` option**. The bounded retry loop (`maxAttempts = WEBHOOK_RETRY_POLICY.maxRetries + 1`) does not help here: if a destination endpoint accepts the connection but never responds, each attempt can hang for a very long time, so a single slow or malicious receiver can pin a delivery worker indefinitely and stall the queue. Because the URL is caller-supplied (subject only to the SSRF guard), an attacker can register a deliberately slow endpoint to exhaust delivery capacity.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a configurable per-request timeout (e.g. `WEBHOOK_DELIVERY_TIMEOUT_MS`, default ~10s) read from validated config in [`src/config/env.schema.ts`](src/config/env.schema.ts), and pass it to the `axios.post` call in [`src/services/webhook.service.ts`](src/services/webhook.service.ts).
- A timed-out attempt must be treated like any other transient failure: count toward `payload.retryCount`, back off via `calculateWebhookRetryDelay`, and fall through to the DLQ on exhaustion — never resolve silently.
- Ensure the timeout interacts correctly with the existing per-host rate-limit and SSRF re-check; do not double-count a single attempt.
- Do not log the full destination URL or payload body at info level; keep host-only logging.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/webhooks-timeout-axios-post`
- Implement changes
  - **Write code in:** [`src/services/webhook.service.ts`](src/services/webhook.service.ts) and [`src/config/env.schema.ts`](src/config/env.schema.ts).
  - **Write comprehensive tests in:** create `src/services/webhook.service.test.ts` — mock axios to simulate a hanging endpoint and assert the timeout fires, the attempt is retried, and exhaustion routes to the DLQ.
  - **Add documentation:** document the timeout env var in [`docs/WEBHOOK-DLQ.md`](docs/WEBHOOK-DLQ.md).
  - Add TSDoc to the delivery method noting the timeout semantics.
  - Validate security: a slow receiver cannot block delivery beyond the configured timeout.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: hang on connect, hang after headers, timeout on the last attempt, fast success.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(webhooks): add bounded timeout to outbound webhook delivery`

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
title: "Validate correlation IDs before injecting them into outbound webhook headers"
labels: type:security, area:observability, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Validate correlation IDs before injecting them into outbound webhook headers

### Description
`buildWebhookHeaders` in [`src/utils/correlationId.ts`](src/utils/correlationId.ts) sets `headers['X-Correlation-Id'] = correlationId` for any truthy value, and `WebhookService.send` in [`src/services/webhook.service.ts`](src/services/webhook.service.ts) does the same inline. The module's own `@security` docblock claims correlation IDs are "validated before use (alphanumeric + hyphen/underscore, max 128 chars)" and "HTTP headers are only set after validation to prevent injection attacks" — but **no such validation exists in the code**. A correlation ID carrying CR/LF or other control characters could enable header injection or response splitting into downstream receivers. This issue makes the documented guarantee real.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a single shared `isValidCorrelationId` / `sanitizeCorrelationId` helper in [`src/utils/correlationId.ts`](src/utils/correlationId.ts) enforcing the documented charset (alphanumeric, hyphen, underscore) and max length (128).
- Apply it in `buildWebhookHeaders` and in the inline header build inside [`src/services/webhook.service.ts`](src/services/webhook.service.ts); an invalid ID is dropped (header omitted), never passed through.
- Reuse the same validation wherever a correlation ID is accepted from an inbound `X-Correlation-Id` header so untrusted input cannot reach logs or headers unfiltered.
- Do not throw on invalid IDs in the delivery hot path; fail safe by omitting the header.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/correlation-id-header-validation`
- Implement changes
  - **Write code in:** [`src/utils/correlationId.ts`](src/utils/correlationId.ts) and [`src/services/webhook.service.ts`](src/services/webhook.service.ts).
  - **Write comprehensive tests in:** create `src/utils/correlationId.test.ts` — assert CR/LF and over-length IDs are rejected/omitted and that valid IDs pass through.
  - **Add documentation:** keep the `@security` docblock accurate and note the rule in [`docs/API.md`](docs/API.md).
  - Add TSDoc to the new validator.
  - Validate security: no header-injection path remains via correlation IDs.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: embedded newline, header-splitting payload, 129-char id, empty id, valid id.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(observability): validate correlation IDs before setting webhook headers`

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
title: "Bound HTTP metrics route-label cardinality to prevent a metric-explosion DoS"
labels: type:security, area:observability, stack:nodejs, stack:typescript, stack:express, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Bound HTTP metrics route-label cardinality to prevent a metric-explosion DoS

### Description
`MetricsService.trackHttpRequest` in [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts) labels `http_requests_total` and `http_request_duration_seconds` with `route = extractRoute(req)`. If `extractRoute` ever falls back to a raw URL/path (rather than the matched Express route template), then paths embedding identifiers — `/contracts/abc`, `/contracts/def`, … — each create a **new Prometheus time series**. An attacker hitting many distinct paths can blow up label cardinality, exhausting memory in the process and in the scraping Prometheus. This is distinct from existing header-redaction and per-provider-gauge work; it is specifically about the unbounded `route` label.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Ensure `extractRoute` resolves to the matched route *template* (e.g. `req.route?.path` joined with `baseUrl`) and never the concrete path with embedded ids; collapse unmatched requests to a single `unmatched` bucket.
- Add a hard cap on distinct `route` label values; once exceeded, attribute further routes to an `other` bucket so cardinality cannot grow without bound.
- Keep `method` and `status_code` labels intact; do not change metric names.
- Make the cap configurable via validated config in [`src/config/env.schema.ts`](src/config/env.schema.ts).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/metrics-route-cardinality-cap`
- Implement changes
  - **Write code in:** [`src/observability/metrics-service.ts`](src/observability/metrics-service.ts).
  - **Write comprehensive tests in:** create `src/observability/metrics-service.test.ts` — fire many distinct concrete paths and assert the number of `route` label values stays bounded and unmatched paths collapse.
  - **Add documentation:** note the cardinality guard in the observability/health section of [`README.md`](README.md).
  - Add TSDoc to `extractRoute` and the cap logic.
  - Validate security: distinct user-controlled paths cannot create unbounded series.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: matched template, unmatched 404, cap boundary, high-cardinality flood.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(observability): bound HTTP metrics route-label cardinality`

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
title: "Fail loudly instead of silently downgrading unknown npm-audit severities to low"
labels: type:security, area:dependency-scan, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Fail loudly instead of silently downgrading unknown npm-audit severities to low

### Description
`normalizeSeverity` in [`src/security/npm-audit-parser.ts`](src/security/npm-audit-parser.ts) returns `'low'` for any value it does not recognise: `if (typeof value === 'string' && isSeverity(value)) return value; return 'low';`. If npm changes its severity labels, or a vulnerability arrives with an unexpected label, a genuinely **critical** advisory is silently reclassified as `low` and may slip past the dependency policy gate in [`src/security/dependency-policy.ts`](src/security/dependency-policy.ts). A security scanner must never quietly weaken a finding. This issue makes unknown severities fail safe (treated as most-severe and/or surfaced) instead of fail-open.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Change `normalizeSeverity` so an unrecognised severity is preserved/flagged rather than downgraded — either map to the highest severity or carry an explicit `unknown` marker that the policy evaluator treats as blocking.
- Emit a structured warning (via [`src/logger.ts`](src/logger.ts)) recording the original unrecognised value so operators can update mappings.
- Keep `normalizeCounts` and the summary shape consumed by [`src/security/dependency-scan-service.ts`](src/security/dependency-scan-service.ts) backward compatible.
- Coordinate with the fail-closed path already present in `dependency-policy.ts` so behaviour is consistent and not double-counted.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/audit-parser-unknown-severity`
- Implement changes
  - **Write code in:** [`src/security/npm-audit-parser.ts`](src/security/npm-audit-parser.ts).
  - **Write comprehensive tests in:** create `src/security/npm-audit-parser.test.ts` — assert known severities pass through, unknown labels are not silently downgraded, and a warning is emitted.
  - **Add documentation:** note the severity handling in [`docs/dependency-scanning.md`](docs/dependency-scanning.md) (create if absent).
  - Add TSDoc to `normalizeSeverity`.
  - Validate security: no advisory can be silently weakened.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: each known severity, a novel label, non-string value, missing field.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(dependency-scan): stop silently downgrading unknown audit severities`

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
title: "Add the missing notifications table migration backing NotificationRepository"
labels: type:feature, area:notifications, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add the missing notifications table migration backing NotificationRepository

### Description
`NotificationRepository` in [`src/repositories/notificationRepository.ts`](src/repositories/notificationRepository.ts) reads and writes a `notifications` table — `saveWebNotification` inserts into it and `findByUser` runs `SELECT ... FROM notifications WHERE user_id = ? ORDER BY created_at DESC` — but the migration list in [`src/db/migrations.ts`](src/db/migrations.ts) never creates that table. Any call therefore fails at runtime with "no such table: notifications", so web notifications are completely broken in a fresh database. This issue adds the migration (with a `user_id` index) so the repository works against a real schema.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a new, append-only migration in [`src/db/migrations.ts`](src/db/migrations.ts) creating `notifications(id PK, user_id, title, message, created_at)` matching the columns selected/inserted by [`src/repositories/notificationRepository.ts`](src/repositories/notificationRepository.ts).
- Add an index on `user_id` (and `created_at`) so `findByUser`'s ordered lookup does not table-scan as volume grows.
- Keep the migration consistent with the existing checksum/transaction machinery in `migrations.ts`; do not edit prior migrations.
- Confirm the repository's column names and the `created_at` → `createdAt` mapping align with the new schema.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/notifications-table-migration`
- Implement changes
  - **Write code in:** [`src/db/migrations.ts`](src/db/migrations.ts) (new migration) and adjust [`src/repositories/notificationRepository.ts`](src/repositories/notificationRepository.ts) only if needed for alignment.
  - **Write comprehensive tests in:** create `src/repositories/notificationRepository.test.ts` — run migrations on a fresh DB, save and read back notifications, and assert ordering and per-user isolation.
  - **Add documentation:** note the table in [`docs/migrations.md`](docs/migrations.md) (or the DB docs).
  - Add TSDoc to the repository methods.
  - Validate: a freshly migrated database supports save/read without "no such table".
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty result for an unknown user, multiple notifications ordered desc, idempotent re-run of migrations.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(notifications): add notifications table migration with user_id index`

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
title: "Replace the resetting fixed-window per-host webhook limiter with a true sliding window"
labels: type:enhancement, area:webhooks, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Replace the resetting fixed-window per-host webhook limiter with a true sliding window

### Description
`WebhookService.checkHostRateLimit` in [`src/services/webhook.service.ts`](src/services/webhook.service.ts) implements a *fixed* window that fully resets `count` and `windowStart` whenever `now - entry.windowStart > HOST_RATE_LIMIT_WINDOW_MS`. Its own TSDoc claims it uses "the same sliding-window algorithm as the HTTP rate-limit middleware," but the reset boundary lets up to `2 × HOST_RATE_LIMIT_MAX` deliveries through across a single boundary (e.g. 60 just before reset, then 60 just after). The `blocked`/`blockedUntil` fields on the entry are also initialised but never used. This issue makes the per-host limiter behave as documented.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace the reset-on-expiry logic with a genuine sliding window (timestamp ledger or weighted previous/current window) so the configured max holds across any rolling `HOST_RATE_LIMIT_WINDOW_MS`.
- Either use the dead `blocked`/`blockedUntil` fields meaningfully or remove them to avoid confusion.
- Keep the shared `RateLimitStore` from [`src/lib/rateLimitStore.ts`](src/lib/rateLimitStore.ts) and the existing DLQ-on-limit behaviour intact.
- Continue keying on hostname only (no raw URLs) and keep the limiter shared across instances.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/webhook-host-sliding-window`
- Implement changes
  - **Write code in:** [`src/services/webhook.service.ts`](src/services/webhook.service.ts) (and [`src/lib/rateLimitStore.ts`](src/lib/rateLimitStore.ts) if shared logic is needed).
  - **Write comprehensive tests in:** create `src/services/webhook.service.test.ts` — use fake timers to drive a burst straddling the window boundary and assert the rolling max is enforced.
  - **Add documentation:** document the per-host limit and env vars in [`docs/WEBHOOK-DLQ.md`](docs/WEBHOOK-DLQ.md).
  - Add TSDoc clarifying the algorithm actually used.
  - Validate: no boundary burst exceeds the configured rolling max.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: at-limit, boundary burst, idle host eviction, multiple hosts independent.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`fix(webhooks): enforce a true sliding window in per-host rate limiter`

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
title: "Advance the contract indexer cursor only over accepted events and never backwards"
labels: type:feature, area:indexer, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Advance the contract indexer cursor only over accepted events and never backwards

### Description
`ContractEventIndexer.indexBatch` in [`src/contracts/indexer.ts`](src/contracts/indexer.ts) computes `maxSequence` from accepted **and** duplicate events and then calls `cursorRepository.updateCursor(sourceId, maxSequence)`. Two problems: (1) events that fail validation (`status === 'invalid'`) are skipped for sequence tracking — good — but the cursor is advanced to the highest *seen* sequence even when later events in the same batch were rejected, so a gap can be created where rejected events are never revisited; and (2) `updateCursor` advances to whatever `maxSequence` is passed, with no guarantee it is monotonic, so an out-of-order or replayed batch could move the cursor backwards and force re-processing. This issue tightens both.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Advance the cursor only to the highest **contiguously accepted/duplicate** sequence, so a rejected event does not let the cursor skip past unprocessed work.
- Make `updateCursor` in [`src/contracts/cursor.repository.ts`](src/contracts/cursor.repository.ts) reject a non-monotonic move (return a typed "cannot move cursor backwards" result) so replays cannot rewind it.
- Preserve the dedupe guarantees in [`src/contracts/dedupe.ts`](src/contracts/dedupe.ts) and the existing `IndexerBatchResult` shape.
- Keep batch sorting (`sortEventsBySequence`) and per-event error isolation unchanged.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/indexer-cursor-monotonic-accepted`
- Implement changes
  - **Write code in:** [`src/contracts/indexer.ts`](src/contracts/indexer.ts) and [`src/contracts/cursor.repository.ts`](src/contracts/cursor.repository.ts).
  - **Write comprehensive tests in:** create `src/contracts/indexer.cursor.test.ts` — assert the cursor does not skip past a rejected event and a backward update is refused.
  - **Add documentation:** note the cursor invariants in [`docs/backend`](docs/backend).
  - Add TSDoc to `indexBatch` and `updateCursor`.
  - Validate: no replay can rewind the cursor; no gap is created by invalid events.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: invalid event mid-batch, duplicate batch replay, out-of-order sequences, empty batch.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`fix(indexer): advance cursor only over accepted events and enforce monotonicity`

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
title: "Equalize the login not-found path to remove a user-enumeration timing side channel"
labels: type:security, area:auth, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Equalize the login not-found path to remove a user-enumeration timing side channel

### Description
`AuthService.login` in [`src/services/auth.service.ts`](src/services/auth.service.ts) tries to be constant-time by hashing a synthetic value when the user is missing: `const storedHash = row?.password_hash ?? \`${"a".repeat(32)}:${"b".repeat(128)}\``. But the synthetic salt:hash is a fixed, trivially-shaped string, so `verifyPassword` may exercise a different code path/cost than a real stored hash, leaving a measurable timing gap between "no such user" and "wrong password." That gap enables user enumeration. This issue makes the not-found path indistinguishable from the wrong-password path.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Replace the ad-hoc dummy hash with a precomputed, realistically-shaped decoy hash (same salt length, same KDF parameters as real hashes) so `verifyPassword` does equivalent work on both paths.
- Ensure the not-found and wrong-password branches return the identical error/code and take comparable time; keep the existing `invalid_credentials` contract.
- Do not log whether the email existed; route any diagnostics through the structured logger without leaking existence.
- Keep `verifyPassword`/`hashRefreshToken` behaviour and the issued-token flow unchanged.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/auth-login-timing-equalize`
- Implement changes
  - **Write code in:** [`src/services/auth.service.ts`](src/services/auth.service.ts).
  - **Write comprehensive tests in:** [`src/services/auth.service.test.ts`](src/services/auth.service.test.ts) — assert identical error for unknown user vs wrong password and that the decoy hash matches real KDF parameters.
  - **Add documentation:** note the anti-enumeration rationale in the auth runbook / module TSDoc.
  - Add TSDoc explaining the constant-time intent.
  - Validate security: no response or timing distinguishes unknown email from wrong password.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: unknown email, known email wrong password, known email correct password, empty inputs.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(auth): equalize login not-found path against user enumeration`

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
title: "Surface web-notification persistence failures instead of returning success"
labels: type:enhancement, area:notifications, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Surface web-notification persistence failures instead of returning success

### Description
In [`src/services/notification.service.ts`](src/services/notification.service.ts) the web-notification path wraps `this.repo.saveWebNotification(...)` in a `try/catch` that only `logger.error`s and then continues, so the method still resolves as if the notification was delivered. When the database is down, full, or rejects a constraint, callers receive a success result while nothing was persisted — a silent data-loss disguised as success. `findByUser` will later return nothing, and operators have no signal. This issue makes a persistence failure a real failure result.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- On a `saveWebNotification` failure, return a `{ success: false, ... }` result (matching the existing `NotificationResult` shape) instead of swallowing the error; do not throw across the public boundary unless that is the established contract.
- Keep logging redacted — do not log full user PII or message bodies at info level; route through [`src/logger.ts`](src/logger.ts).
- Ensure the change is consistent with how other channels in the service report failures, so callers can branch on outcome.
- Update any caller in [`src/services/notification.service.ts`](src/services/notification.service.ts) that assumed success-on-return.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/notification-persist-failure-surface`
- Implement changes
  - **Write code in:** [`src/services/notification.service.ts`](src/services/notification.service.ts).
  - **Write comprehensive tests in:** create `src/services/notification.service.test.ts` — mock the repository to throw and assert the result reports failure (not success).
  - **Add documentation:** note the failure contract in `docs/email-notifications.md` (or the notifications docs).
  - Add TSDoc to the web-notification method.
  - Validate: a persistence error never returns a success result.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: repo throws, repo succeeds, missing fields, redaction of PII in logs.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`fix(notifications): report failure when web-notification persistence fails`

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
title: "Implement real SMTP, SES, and SendGrid email transports behind a fail-fast guard"
labels: type:feature, area:notifications, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Implement real SMTP, SES, and SendGrid email transports behind a fail-fast guard

### Description
`SMTPTransport`, `SESTransport`, and `SendGridTransport` in [`src/services/notification.transport.ts`](src/services/notification.transport.ts) are placeholders: each logs a `(placeholder)` line at info level and returns `{ success: true }` without dispatching anything (the code even carries `TODO: In production, install and use nodemailer here`). Any deployment selecting one of these transports silently drops every email — password resets, dispute alerts, etc. — while reporting success. This issue implements a real dispatch path and makes a misconfigured/placeholder transport fail fast rather than succeed silently.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Implement at least one real provider end-to-end (SMTP via nodemailer is the cleanest) and wire provider selection from validated config in [`src/config/env.schema.ts`](src/config/env.schema.ts); keep the `NotificationResult` contract.
- For any provider that remains unimplemented, fail fast at construction or selection (not at send time) and log at WARN/ERROR — never INFO placeholder + success.
- Validate recipients and guard against header injection before dispatch; redact recipient/body in logs via [`src/logger.ts`](src/logger.ts).
- Keep the transport injectable so tests can supply a mock without real network calls.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/notification-real-email-transports`
- Implement changes
  - **Write code in:** [`src/services/notification.transport.ts`](src/services/notification.transport.ts).
  - **Write comprehensive tests in:** create `src/services/notification.transport.test.ts` — mock the provider client and assert real dispatch, provider-failure propagation, and fail-fast on an unconfigured transport.
  - **Add documentation:** document transport selection and config in `docs/email-notifications.md`.
  - Add TSDoc to each transport's `send`.
  - Validate security: header-injection guard; no PII in logs.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: provider throws, provider times out, unconfigured transport, invalid recipient.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`feat(notifications): implement real email transports with fail-fast guards`

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
title: "Preserve upstream error details so retry classification can branch on status"
labels: type:enhancement, area:http-client, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Preserve upstream error details so retry classification can branch on status

### Description
`UpstreamHttpClient` in [`src/dependencies/upstreamHttpClient.ts`](src/dependencies/upstreamHttpClient.ts) catches axios errors and rethrows a generic `DependencyError`, discarding the original status code and response body. The `isRetryable` callback then receives only the wrapped error, so it cannot distinguish a retryable `429`/`503` from a non-retryable `400`/`404` — retries are effectively all-or-nothing, and operators get an opaque message with no upstream context. This issue threads the original error through so retry logic and diagnostics can be precise.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Carry the upstream status code and (redacted) response detail on the thrown `DependencyError` (e.g. `statusCode`, `originalError`) without leaking secrets.
- Pass enough context to the `isRetryable` predicate that it can branch on status class (retry 408/425/429/5xx, do not retry 4xx others); keep the predicate injectable.
- Redact sensitive headers/bodies before logging via [`src/redact.ts`](src/redact.ts) / the structured logger.
- Preserve the public method signatures consumed by callers of the client.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/upstream-client-error-context`
- Implement changes
  - **Write code in:** [`src/dependencies/upstreamHttpClient.ts`](src/dependencies/upstreamHttpClient.ts).
  - **Write comprehensive tests in:** create `src/dependencies/upstreamHttpClient.test.ts` — assert status is preserved, retryable vs non-retryable branches, and that secrets are redacted.
  - **Add documentation:** note the retry-classification contract in [`docs/backend`](docs/backend).
  - Add TSDoc to the error-wrapping path.
  - Validate security: no secret header/body leaks into the error or logs.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: 429 retryable, 400 non-retryable, network error, response with sensitive body.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`fix(http-client): preserve upstream status for accurate retry classification`

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
title: "Fail fast on an empty CORS allowlist in non-production environments"
labels: type:security, area:cors, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Fail fast on an empty CORS allowlist in non-production environments

### Description
In [`src/config/security.ts`](src/config/security.ts), `parseAllowedOrigins()` can return an empty array (emitting only a `console.warn`), and the exported `corsConfig` is then built from that empty list. The result is a confusing failure mode: every cross-origin request — including local dev from `localhost:3000` — is silently rejected with a CORS error, and the only signal is a warning developers routinely miss. The validation is also run twice (once in `parseAllowedOrigins`, again in `createCorsConfig`). This issue replaces the silent-warn path with a deliberate, visible decision.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Decide and implement explicit behaviour for an empty allowlist: fail fast at startup with a clear error outside production, or fall back to a documented safe default for local dev — but never silently reject all origins with only a `console.warn`.
- Route the message through the structured logger ([`src/logger.ts`](src/logger.ts)) at an appropriate level, not `console.warn`.
- Remove the redundant double validation between `parseAllowedOrigins` and `createCorsConfig`.
- Keep production behaviour strict: production must still require an explicit allowlist.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/cors-empty-allowlist-failfast`
- Implement changes
  - **Write code in:** [`src/config/security.ts`](src/config/security.ts).
  - **Write comprehensive tests in:** create `src/config/security.test.ts` — assert empty allowlist behaviour per environment and that valid origins are accepted.
  - **Add documentation:** document `CORS_ALLOWED_ORIGINS` behaviour in [`docs/configuration.md`](docs/configuration.md).
  - Add TSDoc to the origin parsing/validation helpers.
  - Validate security: production cannot start with an empty/implicitly-permissive allowlist.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: empty in dev, empty in prod, valid list, malformed origin.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`fix(cors): fail fast on empty allowlist instead of silently rejecting`

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
title: "Make poison-message removal in the webhook DLQ atomic to respect the replay cap"
labels: type:enhancement, area:dlq, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Make poison-message removal in the webhook DLQ atomic to respect the replay cap

### Description
`incrementReplayAttempts` in [`src/queue/webhook-dlq.ts`](src/queue/webhook-dlq.ts) increments an entry's attempt count and, when the max is exceeded, calls `this.deleteEntry(id)` to drop the poison message — but the read/increment/delete sequence is not wrapped in a single transaction. A crash or concurrent replay between the increment and the delete can leave the entry in place, so it is picked up and incremented again on restart, exceeding the intended max-replay cap and allowing a poison message to keep failing forever. This issue makes the increment-and-drop atomic.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Wrap the read-modify-(delete | persist) of a DLQ entry in a single SQLite transaction in [`src/queue/webhook-dlq.ts`](src/queue/webhook-dlq.ts) so the cap and the drop are committed together.
- Ensure the poison-drop path and the metric increment (`incrementDLQMetric('drop_poison')`) cannot diverge from the persisted state.
- Keep the public `incrementReplayAttempts` result shape (`{ success, attempts, maxExceeded }`) and the existing singleton accessor behaviour.
- Make the operation idempotent under restart: a re-run must not double-count attempts.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/dlq-poison-drop-transactional`
- Implement changes
  - **Write code in:** [`src/queue/webhook-dlq.ts`](src/queue/webhook-dlq.ts).
  - **Write comprehensive tests in:** create `src/queue/webhook-dlq.test.ts` — assert the increment and drop commit atomically and that a simulated mid-operation failure does not exceed the cap.
  - **Add documentation:** note the cap/transaction guarantee in [`docs/WEBHOOK-DLQ.md`](docs/WEBHOOK-DLQ.md).
  - Add TSDoc to `incrementReplayAttempts`.
  - Validate: poison messages cannot exceed the configured replay cap.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: attempt just below cap, at cap, simulated crash before delete, concurrent replay.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`fix(dlq): make poison-message drop atomic with the replay-cap update`

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
title: "Clamp retry-policy backoff multiplier overrides to a safe upper bound"
labels: type:enhancement, area:queue, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Clamp retry-policy backoff multiplier overrides to a safe upper bound

### Description
`loadRetryPolicyOverrides` in [`src/queue/retry-policy.ts`](src/queue/retry-policy.ts) parses per-job-type backoff overrides from environment variables and accepts any `parsedMultiplier > 0` with **no upper bound**, and does not guard against incoherent combinations (e.g. a `fixed` backoff that still carries a `multiplier`). A misconfigured or hostile `RETRY_POLICY_*_MULTIPLIER=100` produces an exponential-backoff explosion, pushing retry delays to absurd values and effectively stalling a job type. This issue clamps and validates override values.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enforce a sane `[min, max]` range on the parsed multiplier (and on base/max delay) in [`src/queue/retry-policy.ts`](src/queue/retry-policy.ts); clamp out-of-range values and log a warning rather than silently accepting them.
- Reject/ignore incoherent combinations (a `multiplier` on a `fixed` backoff) so the resulting policy is internally consistent.
- Keep the merge with built-in defaults and the existing override precedence intact; coordinate with `MAX_RETRY_ATTEMPTS` so total attempts remain bounded.
- Surface validation through the structured logger; do not throw in the hot path unless boot-time validation is the established pattern.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/retry-policy-multiplier-clamp`
- Implement changes
  - **Write code in:** [`src/queue/retry-policy.ts`](src/queue/retry-policy.ts).
  - **Write comprehensive tests in:** create `src/queue/retry-policy.test.ts` — assert clamping of an out-of-range multiplier, rejection of fixed+multiplier, and that valid overrides pass through.
  - **Add documentation:** document the override env vars and bounds in [`docs/configuration.md`](docs/configuration.md).
  - Add TSDoc to `loadRetryPolicyOverrides`.
  - Validate: no env value can produce an unbounded backoff explosion.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm test`.
- Cover edge cases: multiplier above max, multiplier at boundary, fixed+multiplier, NaN/negative input.
- Include the full `npm test` output and notes in the PR.

### Example commit message
`fix(queue): clamp and validate retry-policy backoff overrides`

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
title: "Tighten the notification email validator against header injection and add tests"
labels: type:test, area:notifications, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Tighten the notification email validator against header injection and add tests

### Description
`isValidEmail` in [`src/services/notification.service.ts`](src/services/notification.service.ts) rejects CR/LF but otherwise uses the loose `^[^\s@]+@[^\s@]+\.[^\s@]+$` pattern, so addresses containing quotes, backslashes, and other characters that SMTP can misinterpret pass validation, and the helper has no dedicated tests. Since validated addresses flow into the (soon real) email transport, a permissive validator is both a correctness and an injection concern. This issue tightens the rule and locks the behaviour down with tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Strengthen `isValidEmail` to reject control characters, comma/semicolon-separated multi-recipients, and quoting/backslash forms that enable header or recipient injection, while still accepting normal RFC-shaped addresses.
- Keep the CR/LF rejection and the boolean contract; do not change the method signature.
- Ensure the validator is applied before any dispatch in the notification path.
- Keep behaviour deterministic and documented so the email transport work can rely on it.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/notification-email-validator-hardening`
- Implement changes
  - **Write code in:** [`src/services/notification.service.ts`](src/services/notification.service.ts).
  - **Write comprehensive tests in:** create `src/services/notification.email-validation.test.ts` — assert rejection of CR/LF, multi-recipient, quoted/backslash forms, and acceptance of valid addresses.
  - **Add documentation:** note the validation rules in `docs/email-notifications.md`.
  - Add TSDoc to `isValidEmail`.
  - Validate security: no header/recipient-injection form passes the validator.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: embedded newline, `a@b,c@d`, `"x"@y.com`, valid `user@example.com`, missing TLD.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(notifications): harden and cover the email validator`

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
title: "Add type-safe handling and tests for the request sanitize middleware"
labels: type:test, area:middleware, stack:nodejs, stack:typescript, stack:express, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Add type-safe handling and tests for the request sanitize middleware

### Description
The `sanitize` middleware in [`src/middleware/sanitize.ts`](src/middleware/sanitize.ts) reassigns `req.body`, `req.query`, and `req.params` from `sanitizeObject(...)`, which returns `any`, so type information for Express's `query`/`params` is lost and downstream handlers can silently receive arrays/objects where strings are expected. The middleware also re-sanitizes on every invocation with no test coverage of its recursion, prototype-safety, or idempotency. This issue restores type safety and pins behaviour with tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Type `sanitizeObject` and the reassignments so `req.query`/`req.params` retain their expected shapes, and guard against prototype-pollution keys (`__proto__`, `constructor`, `prototype`) during recursion.
- Keep the middleware idempotent (running it twice yields the same result) and non-mutating of nested input it does not own where practical.
- Preserve the existing sanitization semantics for strings/nested objects/arrays.
- Do not regress request handling for routes already relying on sanitized input.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/sanitize-middleware-typesafe`
- Implement changes
  - **Write code in:** [`src/middleware/sanitize.ts`](src/middleware/sanitize.ts).
  - **Write comprehensive tests in:** create `src/middleware/sanitize.test.ts` — assert nested sanitization, prototype-pollution rejection, idempotency, and preserved types for query/params.
  - **Add documentation:** note the sanitization contract in [`docs/API.md`](docs/API.md).
  - Add TSDoc to `sanitize` and `sanitizeObject`.
  - Validate security: no `__proto__`/`constructor` key survives sanitization.
- Test and commit

### Test and commit
- Run `npm run lint` and `npm run test:ci`.
- Cover edge cases: deeply nested object, array of objects, prototype-pollution payload, double invocation.
- Include the full `npm test` output and a security notes section in the PR.

### Example commit message
`test(middleware): add type-safe sanitization with prototype-pollution guard`

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
title: "Document the outbound notification subsystem: channels, transports, and persistence"
labels: type:docs, area:notifications, stack:nodejs, stack:typescript, priority:low, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN
assignees: ''
---

## Document the outbound notification subsystem: channels, transports, and persistence

### Description
The notification subsystem spans the orchestration in [`src/services/notification.service.ts`](src/services/notification.service.ts), the transport abstractions in [`src/services/notification.transport.ts`](src/services/notification.transport.ts), persistence in [`src/repositories/notificationRepository.ts`](src/repositories/notificationRepository.ts), and the types in [`src/types/notification.types.ts`](src/types/notification.types.ts) — but there is no single integrator-facing guide explaining the channels (web/email), how a transport is selected and configured, validation rules, and how web notifications are stored and queried. This issue produces that documentation so contributors can extend the subsystem safely.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Describe the supported channels, the `NotificationResult` contract, recipient validation, and how a transport (SMTP/SES/SendGrid) is selected from config.
- Document the web-notification persistence path (the `notifications` table, `saveWebNotification`, `findByUser`) and the failure semantics (a persistence error must report failure, not success).
- Enumerate every relevant env var and mark which are secrets handled by redaction; provide a `.env.example`-aligned snippet without real values.
- Cross-link from [`README.md`](README.md); ensure the document matches the code (no aspirational claims).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/notification-subsystem-guide`
- Implement changes
  - **Write code in:** none beyond doc-only clarifying TSDoc in the notification modules.
  - **Write comprehensive tests in:** rely on the notification service/repository/transport tests to confirm documented behaviour.
  - **Add documentation:** create `docs/email-notifications.md` (and link it from [`README.md`](README.md)).
  - Ensure documented channels/config match the code.
  - Validate: examples reflect real request/response and config shapes.
- Test and commit

### Test and commit
- Run `npm run lint` to ensure no drift.
- Cross-check documented env vars and channels against the implementation.
- Include notes in the PR confirming accuracy.

### Example commit message
`docs(notifications): document channels, transports, and persistence`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord for questions, reviews, and faster merges:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — if this issue and the maintainers helped you ship, we'd be grateful for a **5-star rating**. Clear questions in Discord and tidy, well-tested PRs are the fastest path to a merge and a reward.