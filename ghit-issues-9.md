---
type: Feature
title: "Add unit tests for EventIngestionService validation, dedupe, and persistence paths"
labels: type:test, area:events, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Add unit tests for EventIngestionService validation, dedupe, and persistence paths

### Description
`src/events/eventIngestionService.ts` orchestrates schema validation via `src/events/registry.ts`, deduplication via `src/events/idempotency.ts`, and audit writes via `src/repository/eventAuditRepository.ts`, but it has no dedicated test file of its own. Regressions in the ingestion pipeline are currently only caught indirectly through integration tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Cover the happy path, unknown event type, schema-invalid payload, and duplicate-key short-circuit.
- Assert that a duplicate ingestion does not write a second audit row and returns the original result.
- Use in-memory fakes for the idempotency store and audit repository so tests stay deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/events-ingestion-service-tests`
- **Write code in:** `src/events/eventIngestionService.ts`
- **Write comprehensive tests in:** `src/events/eventIngestionService.test.ts`
- **Add documentation:** `docs/EVENT_INGESTION_IDEMPOTENCY.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`test(events): add unit tests for EventIngestionService pipeline`

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
title: "Reject unauthenticated requests in the contract idempotency middleware instead of falling back to a shared scope"
labels: type:security, area:idempotency, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Reject unauthenticated requests in the contract idempotency middleware instead of falling back to a shared scope

### Description
`src/middleware/contractIdempotency.ts` documents that idempotency keys are scoped to `req.user.id`, but when no authenticated user is present the scope degrades to a shared bucket in `src/db/idempotencyStore.ts`. Two different anonymous callers reusing the same `Idempotency-Key` can then read back each other's stored contract-creation response.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Fail closed with a 401 when the middleware runs without a resolved caller identity.
- Include the caller identity in the stored composite key so cross-caller collisions are impossible.
- Add a regression test proving two distinct callers with the same key get independent results.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/idempotency-scope-fail-closed`
- **Write code in:** `src/middleware/contractIdempotency.ts`
- **Write comprehensive tests in:** `src/middleware/contractIdempotency.test.ts`
- **Add documentation:** `docs/IDEMPOTENCY-QUICK-REFERENCE.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`fix(security): fail closed on unauthenticated contract idempotency requests`

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
title: "Support per-entity retention policy overrides loaded from environment configuration"
labels: type:feature, area:retention, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Support per-entity retention policy overrides loaded from environment configuration

### Description
`src/retention/policies.ts` hardcodes retention periods per `DataEntityType` in its `PERIOD_DURATIONS` table and default policy list. Operators cannot lengthen or shorten retention for a single entity type without editing source, which blocks per-deployment compliance requirements.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add validated override parsing to `src/config/env.schema.ts` so bad values fail fast at startup.
- Merge overrides on top of the built-in defaults; never allow an override below a documented legal minimum.
- Expose the effective, resolved policy set through the retention module for auditability.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/retention-policy-overrides`
- **Write code in:** `src/retention/policies.ts`
- **Write comprehensive tests in:** `src/retention/policies.test.ts`
- **Add documentation:** `docs/DATA_RETENTION.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(retention): support configurable per-entity retention overrides`

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
title: "Consolidate the three request-validation middleware implementations into one module"
labels: type:refactor, area:middleware, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Consolidate the three request-validation middleware implementations into one module

### Description
The repository ships three overlapping Zod validation middlewares: `src/middleware/validation.ts`, `src/middleware/validate.middleware.ts`, and `src/middleware/requestValidation.ts`, plus a fourth variant in `src/modules/contracts/validation.middleware.ts`. They produce different error envelopes, so the same malformed body yields different responses depending on which route validated it.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Keep a single canonical implementation and re-export thin deprecated shims from the other paths.
- Standardize on one field-level error shape aligned with `src/errors/appError.ts`.
- Update every route importing the retired variants and keep existing route tests green.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/middleware-validation-consolidation`
- **Write code in:** `src/middleware/validate.middleware.ts`
- **Write comprehensive tests in:** `src/middleware/validate.middleware.test.ts`
- **Add documentation:** `docs/API.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`refactor(middleware): unify request validation into a single implementation`

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
title: "Document the background queue processor catalog, job payloads, and retry semantics"
labels: type:docs, area:queue, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Document the background queue processor catalog, job payloads, and retry semantics

### Description
`src/queue/processors/` contains blockchain, contract, email, reputation, and reputation-recompute processors wired through `src/queue/queue-manager.ts` with policies from `src/queue/retry-policy.ts`, yet there is no document describing which queues exist or what each job payload looks like. Operators cannot reason about a stuck queue without reading source.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Table every queue name, its processor file, payload type from `src/queue/types.ts`, and concurrency setting.
- Describe retry counts, backoff, and where exhausted jobs land relative to `src/queue/webhook-dlq.ts`.
- Include an operator runbook section for draining and replaying a queue.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/queue-processor-catalog`
- **Write code in:** `src/queue/processors/index.ts`
- **Write comprehensive tests in:** `src/queue/config.test.ts`
- **Add documentation:** `docs/queue-processors.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`docs(queue): document processor catalog, payloads, and retry semantics`

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
title: "Make histogram bucket boundaries configurable in the observability metrics service"
labels: type:enhancement, area:observability, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Make histogram bucket boundaries configurable in the observability metrics service

### Description
`src/observability/metrics-service.ts` registers Prometheus histograms with fixed bucket boundaries, so latency percentiles are unusable for deployments whose real traffic sits outside those ranges. `src/observability/observability-config.ts` already carries tuning knobs and is the natural home for bucket configuration.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Accept bucket arrays through the observability config with validated, strictly increasing values.
- Fall back to the current defaults when no override is supplied so existing dashboards keep working.
- Verify the SLO thresholds in `src/operations/service-objectives.ts` still resolve against the configured buckets.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b enhancement/observability-configurable-buckets`
- **Write code in:** `src/observability/metrics-service.ts`
- **Write comprehensive tests in:** `src/observability/metrics-service.test.ts`
- **Add documentation:** `docs/configuration.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(observability): allow configurable histogram bucket boundaries`

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
title: "Fix the unresolved Database type reference in NotificationRepository and add coverage"
labels: type:refactor, area:notifications, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Fix the unresolved Database type reference in NotificationRepository and add coverage

### Description
`src/repositories/notificationRepository.ts` imports only the `BetterSqlite3` type but annotates its field and constructor with `ReturnType<typeof Database>`, referencing a value that was never imported. The file also has no test, so the broken typing goes unnoticed against the loader in `src/db/betterSqlite3.ts`.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Type the connection as `BetterSqlite3.Database` and drop the dangling `ReturnType<typeof Database>` usage.
- Confirm the module type-checks under `npm run build` with `tsconfig.build.json`.
- Add tests covering insert and retrieval against an in-memory SQLite database.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/notification-repository-typing`
- **Write code in:** `src/repositories/notificationRepository.ts`
- **Write comprehensive tests in:** `src/repositories/notificationRepository.test.ts`
- **Add documentation:** `docs/notifications.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`fix(notifications): correct NotificationRepository database typing`

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
title: "Make the permission matrix in lib/authorization deny by default for unmapped resource actions"
labels: type:security, area:authorization, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Make the permission matrix in lib/authorization deny by default for unmapped resource actions

### Description
`src/lib/authorization.ts` evaluates a static permission matrix over the roles validated by `isValidRole`, but new `Resource`/`Action` pairs added to `src/lib/types.ts` are not forced into the matrix. A resource introduced without a matrix entry can therefore resolve ambiguously rather than being explicitly denied.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Make the matrix exhaustive over `Resource` and `Action` so a missing pair is a compile-time error.
- Return an explicit deny plus a structured log line for any pair that is still unresolved at runtime.
- Add tests asserting deny-by-default for an unknown resource and for a valid role with no grant.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b security/authorization-deny-by-default`
- **Write code in:** `src/lib/authorization.ts`
- **Write comprehensive tests in:** `src/lib/authorization.test.ts`
- **Add documentation:** `AUTH.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`fix(security): enforce deny-by-default in the authorization matrix`

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
title: "Track and expose last-used timestamps and call counts for API keys"
labels: type:feature, area:api-keys, stack:nodejs, stack:typescript, priority:medium, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Track and expose last-used timestamps and call counts for API keys

### Description
`src/auth/apiKeys.ts` and `src/auth/apiKeyMiddleware.ts` verify keys on every request but never record when a key was last presented, so operators cannot identify dormant credentials to revoke. The management endpoints in `src/routes/apiKeys.routes.ts` and `src/controllers/apiKeyController.ts` consequently return no usage signal.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Record last-used timestamp and a monotonic use counter on successful verification, with a throttled write so hot keys do not thrash the database.
- Surface both fields in the list and get responses without ever echoing key material.
- Add a migration under `src/db/migrations.ts` for the new columns.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/api-key-usage-tracking`
- **Write code in:** `src/auth/apiKeys.ts`
- **Write comprehensive tests in:** `src/auth/__tests__/apiKeys.test.ts`
- **Add documentation:** `docs/api-keys.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`feat(api-keys): track last-used timestamp and usage count per key`

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
title: "Migrate the JSON-file DatabaseService in src/database onto the SQLite connection layer"
labels: type:refactor, area:persistence, stack:nodejs, stack:typescript, priority:high, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---
## Migrate the JSON-file DatabaseService in src/database onto the SQLite connection layer

### Description
`src/database/index.ts` persists contracts, users, and API keys to a single `data/database.json` file via full-file read/write, while the rest of the codebase uses SQLite through `src/db/database.ts` and `src/db/betterSqlite3.ts`. The JSON store has no concurrency control, so parallel writes silently lose records, and its `src/database/schema.ts` types drift from the migrated schema.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Reimplement the `DatabaseService` surface on top of the shared SQLite connection, keeping the existing method signatures so callers are unaffected.
- Add migrations in `src/db/migrations.ts` for any table the JSON store owned but SQLite lacks.
- Provide a one-shot import path for an existing `data/database.json` and document it.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/persistence-json-to-sqlite`
- **Write code in:** `src/database/index.ts`
- **Write comprehensive tests in:** `src/database/index.test.ts`
- **Add documentation:** `docs/migrations.md`

### Test and commit
- Run `npm test`, `npm run lint`
- Cover edge cases; include test output

### Example commit message
`refactor(persistence): back DatabaseService with SQLite instead of a JSON file`

### Guidelines
- Minimum 95 percent test coverage for impacted modules
- Clear documentation
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
