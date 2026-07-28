---
type: Feature
title: "Add a webhook subscription management API for per-consumer endpoint registration"
labels: type:feature, area:webhooks, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Add a webhook subscription management API for per-consumer endpoint registration

### Description
`src/services/webhook.service.ts` delivers webhooks to statically configured destinations, so consumers cannot register or manage their own endpoints. There is no CRUD surface for subscriptions alongside the existing routers in `src/routes/`, and `src/types/webhook.types.ts` has no subscription model. Add a persisted subscription registry that webhook delivery resolves at send time.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a `webhook_subscriptions` table via `src/db/migrations.ts` storing url, event types, secret, and active flag.
- Expose authenticated create/list/update/delete routes guarded by `src/middleware/authorization.ts`, validating URLs through `src/utils/ssrf.ts`.
- Have `WebhookDeliveryService` fan out to matching active subscriptions instead of a fixed target list.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/webhooks-subscription-api`
- **Write code in:** `src/services/webhook.service.ts`
- **Write comprehensive tests in:** `src/services/webhook.service.test.ts`
- **Add documentation:** `docs/WEBHOOK-DLQ.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(webhooks): add subscription management API for consumer endpoints`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Support role hierarchy inheritance so admin implicitly grants lower-tier permissions"
labels: type:feature, area:authorization, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Support role hierarchy inheritance so admin implicitly grants lower-tier permissions

### Description
`src/auth/roles.ts` defines roles as a flat set, so `src/auth/authorize.ts` requires every privileged role to be listed explicitly on each route. This makes route guards in `src/routes/admin.routes.ts` and `src/routes/contracts.routes.ts` verbose and easy to get wrong. Introduce an explicit hierarchy where higher roles inherit the permissions of lower ones.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Model the hierarchy as a directed acyclic map in `src/auth/roles.ts` and expose a `hasRoleAtLeast` resolver.
- Update `authorize()` to resolve inherited roles instead of doing a plain membership check.
- Reject cycles in the hierarchy at module load so misconfiguration fails fast.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/authorization-role-hierarchy`
- **Write code in:** `src/auth/roles.ts`
- **Write comprehensive tests in:** `src/routes/admin.routes.test.ts`
- **Add documentation:** `AUTH.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(auth): support role hierarchy inheritance in authorization checks`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Support If-Match preconditions on contract writes to prevent lost updates"
labels: type:enhancement, area:http-caching, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Support If-Match preconditions on contract writes to prevent lost updates

### Description
`src/utils/etag.ts` only supports read-side `If-None-Match` handling, so write requests in `src/controllers/contracts.controller.ts` cannot express "update only if unchanged". Two concurrent PUTs therefore silently overwrite each other. Add `If-Match` precondition evaluation returning `412 Precondition Failed` on mismatch.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add an `evaluateIfMatch` helper in `src/utils/etag.ts` handling `*`, weak/strong comparison, and multi-value headers.
- Wire the check into the contract update path and return errors via `src/errors/appError.ts`.
- Treat a missing `If-Match` as permissive unless the route opts into strict mode.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/http-caching-if-match`
- **Write code in:** `src/utils/etag.ts`
- **Write comprehensive tests in:** `src/routes/contracts.test.ts`
- **Add documentation:** `docs/API.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(etag): add If-Match precondition support for contract writes`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Honor upstream Retry-After headers in the retry backoff utility"
labels: type:enhancement, area:resilience, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Honor upstream Retry-After headers in the retry backoff utility

### Description
`src/utils/retry.ts` computes purely local exponential backoff and ignores the `Retry-After` header returned by throttled upstreams. Callers such as `src/dependencies/upstreamHttpClient.ts` and `src/rpc/stellarClient.ts` therefore keep retrying faster than the provider allows. Parse and respect the server-supplied delay while keeping a safety ceiling.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Parse both delta-seconds and HTTP-date forms of `Retry-After`, ignoring malformed values.
- Clamp the honored delay to a configurable maximum so a hostile upstream cannot stall the worker.
- Fall back to the existing jittered backoff whenever no usable header is present.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/resilience-retry-after`
- **Write code in:** `src/utils/retry.ts`
- **Write comprehensive tests in:** `src/httpClient.test.ts`
- **Add documentation:** `docs/configuration.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(retry): honor upstream Retry-After headers with a clamped ceiling`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add unit tests for the event registry schema lookup and version resolution"
labels: type:test, area:events, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Add unit tests for the event registry schema lookup and version resolution

### Description
`src/events/registry.ts` maps event type names to validation schemas and is consumed by `src/events/eventIngestionService.ts` on every ingested event, yet it has no dedicated test file. Unknown types, duplicate registrations, and version selection are all currently unverified. Add focused unit coverage for the registry contract.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Cover successful lookup, unknown event type rejection, and duplicate registration behavior.
- Assert that schema validation failures surface the offending field path, matching `src/events/types.ts`.
- Verify the registry is immutable after initialization so runtime callers cannot mutate schemas.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/events-registry-coverage`
- **Write code in:** `src/events/registry.ts`
- **Write comprehensive tests in:** `tests/events/registry.test.ts`
- **Add documentation:** `docs/EVENT_INGESTION_IDEMPOTENCY.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`test(events): add unit tests for the event schema registry`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add unit tests for escrow lifecycle hook dispatch and payload shape"
labels: type:test, area:escrow-hooks, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Add unit tests for escrow lifecycle hook dispatch and payload shape

### Description
`src/hooks/escrow.hooks.ts` fans escrow lifecycle events out to the notification service but has no test file, so the emitted payload shape and the set of triggering transitions are unverified. Regressions here silently break downstream consumers of `src/services/notification.service.ts`. Add deterministic unit tests with a stubbed notification service.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Assert one dispatch per lifecycle transition (funded, released, disputed) with the expected payload keys.
- Verify no notification is emitted for unchanged or unknown states.
- Use injected fakes rather than real transports so the suite stays offline and deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/escrow-hooks-dispatch`
- **Write code in:** `src/hooks/escrow.hooks.ts`
- **Write comprehensive tests in:** `src/hooks/escrow.hooks.test.ts`
- **Add documentation:** `docs/notifications.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`test(hooks): add unit tests for escrow lifecycle hook dispatch`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Normalize emails in the user repository to block case-variant duplicate accounts"
labels: type:security, area:identity, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Normalize emails in the user repository to block case-variant duplicate accounts

### Description
`src/repositories/userRepository.ts` stores and looks up emails verbatim, so `User@x.com` and `user@x.com` can register as two distinct accounts. `src/services/auth.service.ts` then resolves logins against whichever row matches exactly, enabling account confusion and impersonation of an existing identity. Normalize on write and lookup, and enforce uniqueness at the schema level.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Lowercase and trim emails in a single helper used by both insert and find paths.
- Add a migration in `src/db/migrations.ts` creating a unique index on the normalized email column.
- Keep the existing constant-time not-found behavior in the login path so no enumeration signal is added.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/identity-email-normalization`
- **Write code in:** `src/repositories/userRepository.ts`
- **Write comprehensive tests in:** `src/services/auth.service.test.ts`
- **Add documentation:** `AUTH.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`fix(security): normalize emails to prevent case-variant duplicate accounts`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add progressive lockout and per-account throttling to the login endpoint"
labels: type:security, area:auth-abuse, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Add progressive lockout and per-account throttling to the login endpoint

### Description
`src/routes/auth.routes.ts` is covered only by the generic IP-based limiter in `src/middleware/rateLimiter.ts`, so a distributed credential-stuffing run can hammer a single account from many addresses. `src/services/auth.service.ts` tracks no failed-attempt state per identity. Add per-account failure counting with progressive lockout.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Track consecutive failures keyed by normalized identity with a configurable threshold and decay window.
- Apply increasing delay then temporary lockout, returning a uniform error that does not reveal lockout state.
- Emit an audit entry through `src/audit/service.ts` on every lockout trigger and release.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/auth-abuse-login-lockout`
- **Write code in:** `src/routes/auth.routes.ts`
- **Write comprehensive tests in:** `src/routes/auth.routes.test.ts`
- **Add documentation:** `AUTH.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(security): add progressive login lockout and per-account throttling`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Publish an observability metrics catalog describing every exported Prometheus series"
labels: type:docs, area:observability, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Publish an observability metrics catalog describing every exported Prometheus series

### Description
Metrics are registered across `src/observability/metrics-service.ts`, `src/utils/webhookMetrics.ts`, and `src/observability/health-service.ts`, but no document lists the exported series, their labels, or their intended alerts. Operators must read source to build dashboards. Publish a catalog that names each metric, its type, labels, and cardinality bounds.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Table every counter, gauge, and histogram with type, labels, and unit.
- Document the `/metrics` scrape contract including the auth requirement in `src/middleware/metricsAuth.ts`.
- Cross-reference the SLO thresholds defined in `src/operations/service-objectives.ts`.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/observability-metrics-catalog`
- **Write code in:** `src/observability/metrics-service.ts`
- **Write comprehensive tests in:** `src/health.test.ts`
- **Add documentation:** `docs/observability.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`docs(observability): add exported metrics catalog and scrape contract`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Unify the three overlapping contract repository implementations behind one interface"
labels: type:refactor, area:persistence, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Unify the three overlapping contract repository implementations behind one interface

### Description
Contract persistence is currently split across `src/contracts/repository.ts`, `src/repositories/contractRepository.ts`, and `src/repositories/contracts.repository.ts`, each with a slightly different method surface. Callers in `src/services/contracts.service.ts` and `src/controllers/contracts.controller.ts` pick inconsistently, which makes behavior depend on the import path. Collapse them into one interface with a single SQLite implementation.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Define one `ContractRepository` interface covering create, get, list, update, and delete with cursor support.
- Migrate all call sites and delete the redundant modules; no behavior change beyond unification.
- Keep the existing types in `src/types/contracts.ts` as the single source of truth for row shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/persistence-unify-contract-repository`
- **Write code in:** `src/repositories/contractRepository.ts`
- **Write comprehensive tests in:** `src/services/contracts.service.test.ts`
- **Add documentation:** `docs/contracts-lifecycle.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`refactor(persistence): unify duplicate contract repository implementations`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
