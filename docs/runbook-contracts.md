# Contracts Operations Runbook

## Overview

This runbook covers the contract-related code that exists in this repository:

- the `predictify-hybrid` Soroban contract in
  [`contracts/predictify-hybrid`](../contracts/predictify-hybrid);
- the HTTP contracts API mounted at `/api/v1/contracts`;
- contract metadata, event ingestion, and event-indexing components;
- Redis-backed contract-processing jobs; and
- Stellar/Soroban RPC configuration and health checks.

These components are not one end-to-end on-chain deployment system. In
particular:

- [`src/services/soroban.service.ts`](../src/services/soroban.service.ts) is a
  mock implementation;
- [`src/queue/processors/contract-processor.ts`](../src/queue/processors/contract-processor.ts)
  simulates blockchain delays rather than submitting transactions;
- the event and cursor repositories in [`src/contracts`](../src/contracts) are
  in-memory implementations; and
- the repository has no Soroban contract deployment command, network alias,
  signing-key integration, or contract-ID publication step.

Do not treat a successful backend deployment as proof that a new Wasm contract
was built or deployed.

## Architecture

### On-chain contract

The Cargo workspace at [`contracts/Cargo.toml`](../contracts/Cargo.toml)
contains one crate, `predictify-hybrid`, defined by
[`contracts/predictify-hybrid/Cargo.toml`](../contracts/predictify-hybrid/Cargo.toml).
Its public entry point is `place_bets` in
[`contracts/predictify-hybrid/src/lib.rs`](../contracts/predictify-hybrid/src/lib.rs).
The implementation in
[`contracts/predictify-hybrid/src/bets.rs`](../contracts/predictify-hybrid/src/bets.rs):

1. requires authorization from the caller;
2. validates the batch and individual bet data;
3. uses instance storage for idempotency keys and bet records; and
4. publishes a `bets_placed` event after the batch succeeds.

Storage keys are defined in
[`contracts/predictify-hybrid/src/storage.rs`](../contracts/predictify-hybrid/src/storage.rs),
and contract errors are defined in
[`contracts/predictify-hybrid/src/errors.rs`](../contracts/predictify-hybrid/src/errors.rs).

### Backend request path

[`src/app.ts`](../src/app.ts) creates the Express application, installs request
IDs, request limits, JSON parsing, structured HTTP logging, and HTTP metrics,
then mounts [`src/routes/contracts.routes.ts`](../src/routes/contracts.routes.ts)
at `/api/v1/contracts`.

That router applies authentication, permission checks, validation, and
idempotency middleware before calling
[`src/controllers/contracts.controller.ts`](../src/controllers/contracts.controller.ts).
The controller delegates to
[`src/services/contracts.service.ts`](../src/services/contracts.service.ts),
which uses
[`src/repositories/contractRepository.ts`](../src/repositories/contractRepository.ts).
The active database implementation is the SQLite singleton in
[`src/db/database.ts`](../src/db/database.ts), with schema and migration logic in
[`src/database/schema.ts`](../src/database/schema.ts) and
[`src/db/migrations.ts`](../src/db/migrations.ts).

Contract metadata has a separate controller/service/repository stack under
[`src/modules/contractMetadata`](../src/modules/contractMetadata) and is mounted
under each contract.

### Events and indexing

The event-processing path is implemented by:

- validation in [`src/contracts/validation.ts`](../src/contracts/validation.ts);
- deterministic identity generation in
  [`src/contracts/dedupe.ts`](../src/contracts/dedupe.ts);
- processing in [`src/contracts/processor.ts`](../src/contracts/processor.ts);
- event storage in [`src/contracts/repository.ts`](../src/contracts/repository.ts);
  and
- ordering and cursor updates in
  [`src/contracts/indexer.ts`](../src/contracts/indexer.ts).

The provided event and cursor repositories are in memory. A process restart
therefore loses their events and checkpoints. The separate
[`src/services/indexer.ts`](../src/services/indexer.ts) writes
`smart_contract_events` to SQLite, but it is not the repository used by
`ContractEventIndexer`.

### Background jobs and dependencies

[`src/index.ts`](../src/index.ts) initializes a BullMQ queue for every
[`JobType`](../src/queue/types.ts). Contract-processing jobs are handled by
[`src/queue/processors/contract-processor.ts`](../src/queue/processors/contract-processor.ts),
with Redis connection and timeout settings from
[`src/queue/config.ts`](../src/queue/config.ts) and retry policy from
[`src/queue/retry-policy.ts`](../src/queue/retry-policy.ts).

[`src/dependencies/contractsClient.ts`](../src/dependencies/contractsClient.ts)
is a separate outbound HTTP client for an upstream contracts service. It uses
timeouts, retries, chaos injection, and the `contracts` circuit breaker.
The main contracts CRUD router does not use this client.

## Configuration

1. Install Node dependencies with `npm ci`.
2. Copy [`.env.example`](../.env.example) to `.env` and replace example values.
3. Review the validated application variables in
   [`src/config/env.schema.ts`](../src/config/env.schema.ts).
4. Review Soroban-specific validation in
   [`src/sorobanEnv.ts`](../src/sorobanEnv.ts), queue validation in
   [`src/queue/config.ts`](../src/queue/config.ts), and RPC transport validation
   in [`src/rpc/stellarConfig.ts`](../src/rpc/stellarConfig.ts).
5. Ensure Redis is reachable before starting a process that initializes queues.

The running CRUD service uses SQLite through [`src/db/database.ts`](../src/db/database.ts).
`DATABASE_URL` is part of the general environment configuration, but it does
not change that repository implementation to PostgreSQL.

## Environment variables

Only variables with implemented behavior relevant to contracts are listed
here. The broader inventory is in
[`docs/backend/environment-variables.md`](backend/environment-variables.md).

| Variable | Implemented behavior |
| --- | --- |
| `PORT` | HTTP listen port; defaults to `3001` in `src/index.ts`. |
| `FORCE_START_INDEX` | `src/index.ts` starts its listener and queues only when this is `1` outside Jest, because its current `isMainModule` constant is `false`. |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | Queue drain timeout registered during server startup; defaults to `30000`. |
| `REDIS_HOST` | BullMQ/health-check Redis host; defaults to `localhost`. |
| `REDIS_PORT` | BullMQ/health-check Redis port; defaults to `6379`. |
| `REDIS_PASSWORD` | Optional Redis password. Never print it during diagnosis. |
| `QUEUE_CONCURRENCY` | BullMQ worker concurrency validated by `src/queue/config.ts`; defaults to `5`. |
| `QUEUE_JOB_TIMEOUT_MS` | Default attempt timeout; defaults to `30000`. |
| `QUEUE_JOB_TIMEOUT_CONTRACT_PROCESSING_MS` | Contract-processing timeout override. |
| `RETRY_POLICY_CONTRACT_PROCESSING_ATTEMPTS` | Contract-processing retry-attempt override, capped at `10`. The built-in policy uses `3`. |
| `RETRY_POLICY_CONTRACT_PROCESSING_DELAY` | Initial retry-delay override. |
| `RETRY_POLICY_CONTRACT_PROCESSING_MULTIPLIER` | Exponential-backoff multiplier override. |
| `RETRY_POLICY_CONTRACT_PROCESSING_JITTER` | Retry jitter override from `0` to `1`. |
| `SOROBAN_RPC_URL` | Validated public Soroban RPC URL used by `sorobanEnv`; default is the source-defined futurenet URL. |
| `SOROBAN_NETWORK_PASSPHRASE` | Validated Soroban network passphrase. |
| `SOROBAN_ESCROW_CONTRACT_ID` | Optional 56-character `C...` contract Strkey. |
| `SOROBAN_TOKEN_CONTRACT_ID` | Optional 56-character token contract Strkey. |
| `SOROBAN_ESCROW_CONTRACT_METADATA_HASH` | Optional pinned 64-character hexadecimal metadata hash. |
| `SOROBAN_RPC_RETRY_ATTEMPTS` | Positive retry count for idempotent SDK reads; defaults to `5`. |
| `SOROBAN_RPC_RETRY_BASE_DELAY_MS` | Positive base delay for idempotent SDK reads; defaults to `200`. |
| `STELLAR_RPC_URL` | Endpoint used by the resilient JSON-RPC client and the `stellar-rpc` health probe. |
| `STELLAR_RPC_TIMEOUT_MS` | Per-attempt JSON-RPC timeout; defaults to `5000`. |
| `STELLAR_RPC_MAX_RETRIES` | JSON-RPC retries after the first attempt; defaults to `3`. |
| `STELLAR_RPC_RETRY_BASE_DELAY_MS` | JSON-RPC retry base delay; defaults to `200`. |
| `STELLAR_RPC_RETRY_MAX_DELAY_MS` | JSON-RPC retry cap; defaults to `2000`. |
| `UPSTREAM_CONTRACTS_URL` | Base URL for `ContractsClient`; its configured default is intentionally non-routable. |
| `UPSTREAM_TIMEOUT_MS` | Timeout for the upstream contracts HTTP client. |
| `GRACEFUL_DEGRADATION_ENABLED` | Controls fallback behavior for that upstream dependency path. |
| `CB_FAILURE_THRESHOLD`, `CB_SUCCESS_THRESHOLD`, `CB_TIMEOUT_MS` | Circuit-breaker thresholds, including the `contracts` breaker. |
| `REQUIRED_ENV_VARS` | Comma-separated names checked by the `env` readiness probe. |
| `METRICS_ENABLED` | Parsed by `src/observability/observability-config.ts`; the current app does not use that parsed flag to mount a scrape route. |
| `METRICS_AUTH_TOKEN` | Protects the mounted `/api/v1/metrics` write routes when configured. |
| `LOG_LEVEL` | Pino log threshold; see `src/logger.ts`. |

There are two RPC variable families because two implementations exist:
`SOROBAN_*` configures the SDK-oriented Soroban modules, while `STELLAR_RPC_*`
configures [`src/rpc/stellarClient.ts`](../src/rpc/stellarClient.ts). Set the
family required by the code path being operated; the readiness probe
specifically checks `STELLAR_RPC_URL`.

## Startup procedure

### Backend

1. Confirm the intended environment variables are present without printing
   secret values.
2. Confirm Redis responds at the configured host and port.
3. Run `npm ci`.
4. Run `npm run build`.
5. Start the compiled entry point with `FORCE_START_INDEX=1` in its environment
   and run `npm start`.
6. Wait for the listener message from [`src/index.ts`](../src/index.ts).
7. Check `/health/live`, then `/health/ready`.
8. Exercise an authenticated read such as `GET /api/v1/contracts/bounds`.

The `FORCE_START_INDEX` requirement reflects the current code: `npm start`
executes `dist/index.js`, while `src/index.ts` has `isMainModule = false`.
Without `FORCE_START_INDEX=1`, importing/executing that module creates the app
but does not bind the HTTP listener or initialize queues.

Development can use `npm run dev` with the same bootstrap caveat. Tests import
the app without starting the listener or Redis-backed queues.

### Rust contract checks

The repository defines Cargo build and test behavior but no deployment
behavior. From the repository root, the source-backed verification commands
are:

```text
cargo test --manifest-path contracts/Cargo.toml
cargo build --manifest-path contracts/Cargo.toml
```

These commands compile/test the crate. They do not deploy it.

## Deployment procedure

### Backend deployment

The implemented GitHub workflow is
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

1. Deployment is skipped unless the repository secret `DEPLOY_ENABLED` is set.
2. The workflow selects production from `main`, staging from `staging`, or
   development from `develop`; a manual dispatch can select an environment.
3. It installs dependencies, lints, tests with coverage, and builds.
4. It runs the environment/deployment validators.
5. It downloads the `dist`, `package.json`, and `package-lock.json` artifact.

The workflow's actual infrastructure deployment and post-deployment HTTP probe
are placeholders. Operators must not report a service or contract deployment
from the workflow's echo-only deploy step.

The repository also implements local blue/green commands (`deploy:status`,
`deploy:switch-green`, and `deploy:rollback`) in
[`src/deploy.ts`](../src/deploy.ts) and documents them in
[`docs/deploy.md`](deploy.md). Those commands switch backend instances; they do
not deploy the Soroban Wasm contract.

### On-chain contract deployment

No on-chain deployment procedure exists in this repository. Before deploying
`predictify-hybrid`, a separate approved procedure must define at least the
target network, compiled artifact, deploy command/tool version, signer custody,
resulting contract ID, verification, and rollback/upgrade policy. Do not infer
those values from `.env.example`.

## Health checks

Use the endpoints implemented in [`src/health`](../src/health) and documented
in [`docs/health.md`](health.md):

| Check | Expected result | Meaning |
| --- | --- | --- |
| `GET /health/live` | `200` | Process is alive; this does not prove dependencies work. |
| `GET /health/ready` | `200` | SQLite, Stellar RPC, and Redis checks pass and the process is not draining. |
| `GET /health` | `200` | Legacy process-level response. Because it is mounted before the aggregate health router, it does not report dependency readiness. |

The `/health/ready` implementation in [`src/health.ts`](../src/health.ts) calls
the SQLite, Stellar RPC, and Redis probes from
[`src/health/probes.ts`](../src/health/probes.ts). The broader probe module also
implements checks for:

- required environment-variable presence;
- queue state; and
- registered circuit-breaker state.

Those broader environment, queue, and circuit-breaker probes are not part of
the `/health/ready` route in `src/health.ts`. The RPC probe treats HTTP status
below `500` as reachable. It does not call a contract method, validate a
deployed contract ID, or prove transaction submission works.

## Monitoring

Prometheus metric collection is implemented by
[`src/observability/metrics-service.ts`](../src/observability/metrics-service.ts)
and catalogued in [`docs/observability.md`](observability.md). The current app
mounts metric write routes at `/api/v1/metrics`, but it does not mount a
Prometheus `GET /metrics` scrape handler. Where the runtime exposes the
registry through additional infrastructure, monitor:

- `http_requests_total` and `http_request_duration_seconds`, filtering normalized
  routes under `/api/v1/contracts`;
- `service_health_status` (`2` up, `1` degraded, `0` down);
- readiness probe results and latency;
- the `contracts` circuit-breaker state from health output; and
- BullMQ failed-job/DLQ state through the implemented admin job endpoints in
  [`src/index.ts`](../src/index.ts).

The contracts API SLO definitions are in
[`src/operations/service-objectives.ts`](../src/operations/service-objectives.ts)
and [`docs/backend/SLA_SLO.md`](backend/SLA_SLO.md).

There is no contract-specific on-chain event-lag, ledger-height, transaction
success, or deployed-Wasm metric in the repository. Do not create an alert that
claims to use one until it is implemented.

## Logging

[`src/logger.ts`](../src/logger.ts) emits structured Pino records, and
[`src/middleware/httpLogger.ts`](../src/middleware/httpLogger.ts) records HTTP
request completion with request/correlation context. Contract queue jobs bind
`processor: "contract"`, `action`, and available correlation IDs.

During an incident, search by:

- `requestId` or `correlationId`;
- normalized contract route and HTTP status;
- `processor: "contract"`;
- messages such as `Contract processing rejected` or `Processing contract operation`;
- `health_check`; and
- circuit-breaker or RPC error messages.

Do not log Redis passwords, authorization headers, signing material, contract
payload secrets, or metadata marked sensitive. Contract IDs are intentionally
logged only at debug level by the queue processor. Redaction rules and query
examples are in
[`docs/backend/structured-logging.md`](backend/structured-logging.md).

One legacy indexer, [`src/services/indexer.ts`](../src/services/indexer.ts),
uses `console.log` with contract IDs. Account for that if it is wired into a
runtime, and avoid copying those identifiers into incident channels unless
necessary.

## Common failure modes

| Symptom | Likely implemented cause | First checks |
| --- | --- | --- |
| `npm start` exits or stays silent without listening | `FORCE_START_INDEX` is not `1` | Inspect the process environment and `src/index.ts`; do not assume the port is bound. |
| Startup configuration error | Invalid general, queue, Soroban, or RPC environment value | Read the named validation issue; compare with `src/config/env.schema.ts`, `src/queue/config.ts`, `src/sorobanEnv.ts`, or `src/rpc/stellarConfig.ts`. |
| `/health/ready` returns `503` | SQLite, Redis, or Stellar RPC is unavailable, a probe timed out, or shutdown draining has started | Inspect the non-production check detail or production logs. |
| Contract API returns `401` or `403` | Missing authentication or insufficient role/ownership permission | Check `src/routes/contracts.routes.ts` and `src/lib/authorization.ts`. |
| Contract create returns a conflict | Reused idempotency key with a different payload, or an OCC conflict | Check the `Idempotency-Key`, caller identity, and supplied version. |
| Contract request returns validation error | DTO, lifecycle, amount, milestone, or identifier bounds failed | Check `src/modules/contracts/dto`, `src/contracts/bounds.ts`, and `src/services/contracts.service.ts`. |
| Upstream contracts path returns degraded data or `503` | Upstream timeout/error or open `contracts` circuit breaker | Check `UPSTREAM_CONTRACTS_URL`, the breaker probe, and `ContractsClient` logs. |
| Contract-processing job retries or reaches failed jobs | Invalid contract ID/action, timeout, Redis interruption, or processor error | Inspect job status, structured processor logs, timeout, and retry policy. |
| Events reappear missing after restart | Event/cursor repository is in memory | Confirm which indexer implementation is active; replay from the authoritative source if available. |
| On-chain state does not change after a successful job | Current processor and `SorobanService` are simulated/mock implementations | Do not retry expecting an on-chain write; verify the actual integration path. |
| Cargo warns that crate profiles are ignored | Release profiles are in the member manifest instead of the workspace root | Treat the warning as a build-configuration issue; inspect both Cargo manifests. |

## Alert response

No deployed alert rules are stored in this repository. The Prometheus rule
examples in [`docs/observability.md`](observability.md) are documentation, not
proof that alerts are installed.

For any contracts-related alert:

1. Record the alert time, environment, route/job, and correlation identifiers.
2. Check `/health/live` and `/health/ready`; do not use the legacy `/health`
   response as dependency-readiness evidence.
3. Separate HTTP/API, Redis/queue, SQLite, upstream-contracts, and Stellar RPC
   failures using the named probe and structured logs.
4. Check whether the `contracts` circuit breaker is open.
5. Determine whether the failed operation is local persistence, a simulated
   job, an RPC read, or a real external transaction before retrying.
6. For a recent backend release, use the implemented blue/green status and
   rollback controls only after verifying that the previous color is healthy.
7. Escalate an on-chain incident when the repository cannot establish deployed
   contract identity, signer state, or ledger transaction outcome.

## Recovery procedures

### Backend regression

1. Run `npm run deploy:status`.
2. Verify the previously active color is healthy.
3. Run `npm run deploy:rollback`.
4. Recheck `/health/live`, `/health/ready`, and a contracts API read.
5. Preserve request IDs and logs for follow-up.

The limitations and state model of rollback are documented in
[`docs/deploy.md`](deploy.md). A backend rollback does not roll back on-chain
contract state.

### Redis or queue interruption

1. Restore connectivity to the configured Redis host.
2. Confirm the Redis readiness probe returns up.
3. Restart the backend if queue initialization did not recover.
4. Inspect failed jobs through the implemented admin job endpoints.
5. Replay only the identified failed job. Respect its idempotency and retry
   history; do not bulk replay without reviewing payloads.

Queue retry and failed-job behavior is implemented in
[`src/queue/queue-manager.ts`](../src/queue/queue-manager.ts) and
[`src/queue/retry-manager.ts`](../src/queue/retry-manager.ts).

### SQLite failure

1. Stop writes or remove the unhealthy instance from traffic.
2. Preserve the database and its `-wal`/`-shm` companions before filesystem
   repair or replacement.
3. Restore using the environment's established backup procedure.
4. Start the service and require the database readiness probe to pass.
5. Verify a contracts read and contract metadata read.

This repository implements migrations but does not contain a database backup
or restore command. Do not invent one.

### Event-indexer restart or replay

The in-memory `ContractEventIndexer` cursor cannot be recovered after process
loss. If an authoritative event source and last verified sequence are
available, reconstruct the indexer and replay events in sequence. Its
deduplication key is `contractId:eventId:sequence`; overlapping replay is safe
only while the event repository retaining those keys is still present. See
[`INDEXER.md`](../INDEXER.md) and
[`docs/backend/contract-indexer-cursors.md`](backend/contract-indexer-cursors.md).

Do not claim durable crash recovery until persistent implementations replace
both in-memory repositories.

### Stellar RPC outage

1. Confirm `STELLAR_RPC_URL` is present and the readiness probe failure is
   reproducible.
2. Check RPC timeout/retry and circuit-breaker logs.
3. Verify the configured network/passphrase and contract IDs belong together.
4. Restore the configured endpoint or update configuration through the
   environment's normal secret/configuration mechanism.
5. Restart if configuration is loaded only at module startup.
6. Recheck readiness before resuming work.

Do not automatically retry transaction submission: the resilient RPC code
retries idempotent reads, while mutating submissions require explicit outcome
reconciliation.

### On-chain contract recovery

No upgrade, migration, rollback, pause, or redeploy mechanism is documented or
implemented for `predictify-hybrid`. Preserve the transaction hash, network,
contract ID, caller, ledger/time, parameters, and emitted events, then escalate
to the contract owner. Do not deploy another contract or mutate instance
storage from this runbook.

## Troubleshooting

Use this order to minimize unsafe retries:

1. Establish which component failed: HTTP CRUD, metadata, event ingestion,
   in-memory indexer, SQLite indexer, BullMQ job, upstream contracts client, or
   Soroban RPC.
2. Correlate the request/job with `requestId` and `correlationId`.
3. Check liveness, readiness, and the exact failing probe.
4. Validate configuration names and formats without exposing values.
5. Check persistence: SQLite records, Redis job state, or in-memory-only state.
6. Check idempotency/OCC state before repeating a write.
7. Reproduce with the smallest read-only operation available.
8. Roll back only the backend release implicated by evidence.

Useful code-level tests include the contract route/service/repository tests,
the event processor/indexer tests under [`src/contracts`](../src/contracts),
the queue processor test
[`src/queue/processors/contract-processor.test.ts`](../src/queue/processors/contract-processor.test.ts),
and Rust tests in
[`contracts/predictify-hybrid/src/batch_operations_tests.rs`](../contracts/predictify-hybrid/src/batch_operations_tests.rs).

## Operational checklist

### Before startup or backend deployment

- [ ] Confirm the intended commit and environment.
- [ ] Validate required environment variables without printing secrets.
- [ ] Confirm SQLite storage is writable and Redis is reachable.
- [ ] Confirm RPC URL, network passphrase, and configured contract IDs match.
- [ ] Run lint, tests, and build.
- [ ] Confirm `FORCE_START_INDEX=1` is set for the current compiled entry point.
- [ ] Confirm no step is being represented as an on-chain deployment.

### After startup or backend deployment

- [ ] `/health/live` returns `200`.
- [ ] `/health/ready` returns `200`.
- [ ] Redis, database, and RPC readiness checks are acceptable.
- [ ] Queue and circuit-breaker state are checked separately.
- [ ] An authenticated contracts read succeeds.
- [ ] Contract-route latency/error metrics remain within the documented SLO.
- [ ] No new failed contract-processing jobs appear.
- [ ] Logs contain correlation fields and no secrets.

### Incident closeout

- [ ] Record impact, component, start/end time, and correlation IDs.
- [ ] Record whether any write was retried and its idempotency evidence.
- [ ] Record backend version/color separately from on-chain contract identity.
- [ ] Confirm recovery with health plus a component-specific check.
- [ ] Document gaps exposed by the incident; do not silently encode manual
  assumptions as runbook steps.

## References

- [`contracts/predictify-hybrid/src/lib.rs`](../contracts/predictify-hybrid/src/lib.rs)
  and [`contracts/predictify-hybrid/src/bets.rs`](../contracts/predictify-hybrid/src/bets.rs)
- [`src/app.ts`](../src/app.ts) and [`src/index.ts`](../src/index.ts)
- [`src/routes/contracts.routes.ts`](../src/routes/contracts.routes.ts)
- [`src/services/contracts.service.ts`](../src/services/contracts.service.ts)
- [`src/repositories/contractRepository.ts`](../src/repositories/contractRepository.ts)
- [`src/contracts`](../src/contracts)
- [`src/queue/processors/contract-processor.ts`](../src/queue/processors/contract-processor.ts)
- [`src/sorobanEnv.ts`](../src/sorobanEnv.ts) and
  [`src/rpc/stellarClient.ts`](../src/rpc/stellarClient.ts)
- [`src/health/probes.ts`](../src/health/probes.ts)
- [`src/observability/metrics-service.ts`](../src/observability/metrics-service.ts)
- [`docs/contracts-lifecycle.md`](contracts-lifecycle.md)
- [`docs/backend/contract-event-processing.md`](backend/contract-event-processing.md)
- [`docs/health.md`](health.md), [`docs/observability.md`](observability.md), and
  [`docs/deploy.md`](deploy.md)
