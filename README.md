# TalentTrust Backend

Express API for the TalentTrust decentralized freelancer escrow protocol.
Handles contract metadata, reputation, and integration with Stellar/Soroban.

## Features

- **Queue-Based Background Jobs**: Durable job processing with BullMQ and Redis
- **Contract Processing**: Asynchronous blockchain contract operations
- **Email Notifications**: Non-blocking email delivery
- **Reputation System**: Background reputation score calculations
- **Blockchain Sync**: Efficient blockchain data synchronization
- **Idempotent Event Processing**: Guaranteed safe event replay with deduplication
- **Strict Schema Validation**: Contract-specific payload validation
- **Audit Trail**: Complete processing history and statistics
- **Stale-While-Revalidate Caching**: SWR caching for upstream resources with degraded signals

## Dependency Chaos Testing

The backend includes dependency-level chaos testing to simulate upstream outages and verify graceful degradation.

### Behavior

- `GET /api/v1/contracts` returns upstream data during normal operation.
- On upstream failures with graceful degradation enabled, it returns a safe fallback payload with `degraded: true`.
- If graceful degradation is disabled, it returns `503` with `contracts_unavailable`.

### Chaos Testing Configuration

- `GRACEFUL_DEGRADATION_ENABLED=true|false` (default `true`)
- `UPSTREAM_CONTRACTS_URL` (default `https://example.invalid/contracts`)
- `UPSTREAM_TIMEOUT_MS` (default `1200`, bounded to `100..10000`)
- `CHAOS_MODE=off|error|timeout|random` (default `off`)
- `CHAOS_TARGETS` (comma-separated dependencies like `contracts`)
- `CHAOS_PROBABILITY` (float `0..1`, used by `random` mode)

### Docs

Detailed architecture and security notes are in `docs/backend/chaos-testing.md`.

Developer onboarding and blue-green local setup are documented in [docs/backend/developer-onboarding-blue-green.md](docs/backend/developer-onboarding-blue-green.md).
Detailed authentication design, lifecycle, and refresh-token rotation semantics are documented in [AUTH.md](AUTH.md).

## Soroban RPC Outbound Retries

Outbound RPC queries to the Stellar/Soroban network are wrapped in an automatic retry-with-backoff mechanism to protect against transient network failures.

* **Idempotent Reads**: Queries like `getLedgerEntries`, `getLatestLedger`, `getEvents`, `simulateTransaction`, and the polling check `getTransaction` are wrapped with a jittered exponential back-off helper.
* **Mutating Transactions**: Submitting signed transactions via `sendTransaction` is **never** retried automatically to prevent accidental double-submission or transaction collisions.

### Configuration

You can configure retry behavior using the following environment variables:

| Variable | Default | Description |
|---|---|---|
| `SOROBAN_RPC_RETRY_ATTEMPTS` | `5` | Maximum number of retry attempts for read calls. |
| `SOROBAN_RPC_RETRY_BASE_DELAY_MS` | `200` | The initial base delay in milliseconds, scaled exponentially with jitter. |

Detailed authentication design, lifecycle, and refresh-token rotation semantics are documented in [AUTH.md](AUTH.md).

## Error Handling and Testing

The backend enforces a consistent API error envelope and status-code policy across request validation, routing, dependency failures, and unexpected runtime errors.

### Error Envelope

All handled errors return:

```json
{
	"error": {
		"code": "machine_readable_code",
		"message": "safe message",
		"requestId": "request-correlation-id"
	}
}
```

### Status-Code Guarantees

- `400` for malformed JSON (`invalid_json`) and request validation errors (`validation_error`)
- `404` for unknown routes (`not_found`)
- `503` for expected dependency outages (`dependency_unavailable`)
- `500` for unexpected failures (`internal_error`)

### Error Codes

Error `code` values are stable machine-readable API contract strings. Clients may branch on them, and new codes should be appended without renaming or removing existing values.

| Code | Meaning |
|---|---|
| `bad_request` | The request could not be processed. |
| `conflict` | The request conflicts with the current resource state. |
| `contract_metadata_mismatch` | Contract metadata failed the pinned-value check. |
| `dependency_unavailable` | A required upstream service is temporarily unavailable. |
| `ERR_CONFLICT` | Optimistic concurrency version conflict. |
| `ERR_INVALID_VERSION` | Update version is not a non-negative integer. |
| `ERR_MISSING_VERSION` | Update version field is missing. |
| `forbidden` | The authenticated user is not permitted to perform the action. |
| `internal_error` | An unexpected error occurred. |
| `invalid_json` | Request body JSON is malformed. |
| `invalid_webhook_signature` | Webhook signature verification failed. |
| `not_found` | The requested resource was not found. |
| `payload_too_large` | Request payload exceeds the configured limit. |
| `rate_limited` | Too many requests were sent in the allowed window. |
| `unauthorized` | Authentication is required or invalid. |
| `unsupported_media_type` | Request content type is unsupported. |
| `validation_error` | Request or business-rule validation failed. |

Detailed notes are in `docs/backend/error-handling.md`.

## Contract Event Processing

The backend now includes a deterministic contract event processing pipeline focused on three semantics:

1. Ingestion: validate inbound event payloads before business processing.
2. Deduplication: compute a stable event identity key (`contractId:eventId:sequence`) and treat replays as idempotent duplicates.
3. Persistence: store accepted events through a repository abstraction (current implementation: in-memory).

### Event Ingestion Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/events` | Process events with idempotency guarantees |
| `POST` | `/api/v1/events/validate` | Validate events without processing |
| `GET` | `/api/v1/events/stats` | Processing statistics |
| `GET` | `/api/v1/contracts/{contractId}/history` | Contract event history |

### Ingestion outcomes

- `accepted` (`202`): new, valid event persisted.
- `duplicate` (`200`): replayed event already processed.
- `invalid` (`400`): payload failed validation.
- `error` (`500`): unexpected internal persistence/processing failure.

## Prerequisites

- Node.js 18+
- npm

## Setup

```bash
git clone <your-repo-url>
cd talenttrust-backend
npm install
```

## Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run production server |
| `npm run dev` | Run with ts-node-dev (hot reload) |
| `npm test` | Run Jest tests |
| `npm run test:ci` | Run tests with coverage enforcement (≥95%) |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run audit:ci` | Fail on HIGH/CRITICAL npm vulnerabilities |

## Configuration

Copy environment template:
```bash
cp .env.example .env
```

Key event ingestion configuration:
```bash
# Event Ingestion Configuration
ENABLE_STRICT_VALIDATION=true
ENABLE_PAYLOAD_INTEGRITY_CHECK=true
MAX_EVENT_AGE_MS=86400000
EVENT_BATCH_SIZE=100
EVENT_TIMEOUT_MS=5000
IDEMPOTENCY_TTL_MS=3600000
```

### Queue Job Timeouts

Queue workers enforce a wall-clock timeout for every job attempt. When a job exceeds its timeout, the queue manager aborts the processor `AbortSignal`, fails the attempt, and lets the existing retry/DLQ policy decide whether to retry or retain the job as failed.

| Variable | Default | Description |
|---|---:|---|
| `QUEUE_JOB_TIMEOUT_MS` | `30000` | Default per-job attempt timeout in milliseconds. |
| `QUEUE_JOB_TIMEOUT_EMAIL_NOTIFICATION_MS` | `QUEUE_JOB_TIMEOUT_MS` | Timeout override for email notification jobs. |
| `QUEUE_JOB_TIMEOUT_CONTRACT_PROCESSING_MS` | `QUEUE_JOB_TIMEOUT_MS` | Timeout override for contract processing jobs. |
| `QUEUE_JOB_TIMEOUT_REPUTATION_UPDATE_MS` | `QUEUE_JOB_TIMEOUT_MS` | Timeout override for reputation update jobs. |
| `QUEUE_JOB_TIMEOUT_REPUTATION_RECOMPUTE_MS` | `QUEUE_JOB_TIMEOUT_MS` | Timeout override for reputation recompute jobs. |
| `QUEUE_JOB_TIMEOUT_BLOCKCHAIN_SYNC_MS` | `QUEUE_JOB_TIMEOUT_MS` | Timeout override for blockchain sync jobs. |

Processors receive an `AbortSignal` as optional context and should stop outbound work when it is aborted. The manager still fails the attempt on timeout when a processor ignores the signal, and it prevents the same job from being executed again while the timed-out processor is still active.

### Weighted Fair Scheduling

Queue workers no longer run a strict priority ladder. A **weighted fair scheduler** ensures a high-priority stream cannot starve reconciliation, notification, or cleanup jobs indefinitely:

- **Weighted fairness** — each priority level has a weight (`critical` 4, `high` 3, `normal` 2, `low` 1) and service is proportional to weight.
- **Maximum wait bound** — a job waiting longer than `QUEUE_FAIR_MAX_WAIT_MS` (default 5 min) is promoted to the front unconditionally.
- **Per-tenant isolation** — pass an optional `tenantId` to `addJob`; a tenant flood cannot block other tenants.
- **Worker-restart safe** — scheduling is a pure function of durable job metadata, so a restarted worker computes the same order.
- **Observable** — scheduling decisions are exposed as `queue_fair_*` Prometheus metrics.

Configuration: `QUEUE_FAIR_MAX_WAIT_MS`, `QUEUE_FAIR_REBALANCE_INTERVAL_MS`. See [docs/backend/queue-fair-scheduling.md](docs/backend/queue-fair-scheduling.md) for the full design and edge cases.

For full configuration details, see [docs/backend/config.md](docs/backend/config.md).

## Audit Log Export

The audit export endpoint streams compliance exports as NDJSON or CSV without loading the full table into memory.

### Endpoint

```
GET /api/v1/audit/export
```

Requires `admin` or `auditor` role. Returns a streamed file attachment.

### Query Parameters

| Parameter    | Type   | Description                                              |
|--------------|--------|----------------------------------------------------------|
| `from`       | ISO-8601 | Start of time range (inclusive). e.g. `2024-01-01T00:00:00.000Z` |
| `to`         | ISO-8601 | End of time range (inclusive).                          |
| `action`     | string | Filter by event type (e.g. `CONTRACT_CREATED`).          |
| `severity`   | string | Filter by severity: `INFO`, `WARNING`, or `CRITICAL`.    |
| `actor`      | string | Filter by actor ID.                                      |
| `resource`   | string | Filter by resource type (e.g. `contract`, `user`).       |
| `resourceId` | string | Filter by resource instance ID.                          |

All parameters are optional. Omitting them exports all records.

### Output formats

- **NDJSON** (default) — one JSON object per line, `Content-Type: application/x-ndjson`
- **CSV** — header row + one data row per entry, columns: `id,timestamp,action,severity,actor,resource,resourceId,ipAddress,correlationId,metadata`

### Memory safety

Rows are fetched via a SQLite cursor and piped to a temp file in configurable batch sizes (default 500). The response is then streamed from the temp file. Peak heap usage is proportional to one batch, not the total result set.

### Redaction

All sensitive metadata fields (`password`, `token`, `secret`, `credential`, `apikey`, `api_key`, `private`) are replaced with `[REDACTED]` and email addresses are partially masked before the data reaches the export file.

## Documentation

- [Reputation Operations Runbook](docs/runbook-reputation.md)
- [Backend Notification Services](./docs/backend/notifications.md)
- [Outbound Notification Subsystem (channels, transports, persistence)](docs/email-notifications.md)
- [Event Ingestion Idempotency](docs/EVENT_INGESTION_IDEMPOTENCY.md)
- [SLA/SLO Definitions and Alert Thresholds](docs/backend/SLA_SLO.md)
- [SLO Runtime Evaluation](#slo-runtime-evaluation)
- [Redis Testing Guide](docs/backend/redis-testing-guide.md)
- [Escrow Contract Lifecycle & Bounds](docs/contracts-lifecycle.md)
- [Contract Event Indexer Cursor Model & Replay Protection](INDEXER.md)
- [Data Retention, Archival, and Purge Lifecycle](docs/DATA_RETENTION.md)
- [Disputes Operations Runbook](docs/runbook-disputes.md) — Configuration, failure modes, alerts, and recovery procedures for the disputes subsystem

## CI/CD

GitHub Actions runs four gates on every push and pull request to `main`:

1. **Lint** — ESLint with TypeScript-aware rules
2. **Test** — Jest with ≥95% line/function/statement coverage
3. **Build** — TypeScript strict compilation (runs after lint + test pass)
4. **Security Audit** — `npm audit --audit-level=high`

All four checks must pass before a PR can be merged. See
[docs/backend/branch-protection.md](docs/backend/branch-protection.md) for
the recommended GitHub branch protection settings.

## License

MIT License - see LICENSE file for details.

## Project Structure

```
src/
├── index.ts          # Server entry point
├── app.ts            # Express app factory
└── routes/
    ├── health.ts     # GET /health
    └── contracts.ts  # GET /api/v1/contracts
```

See [docs/backend/architecture.md](docs/backend/architecture.md) for design
decisions and planned integrations.

## Security

The TalentTrust Backend implements hardened HTTP response policies and origin controls.

- **Security Headers**: Managed via [Helmet](https://helmetjs.github.io/) (CSP, HSTS, etc.).
- **CORS Policy**: Strict allowlist controlled by environment configuration.

### HTTP request logging redaction

Structured HTTP logs preserve operational metadata needed for debugging and tracing while masking credential-bearing headers before any request or response log line is emitted.

**Logged fields retained in cleartext**
- HTTP method
- Request path / URL
- Response status code
- Latency / duration
- Request ID and correlation ID
- Client IP and truncated User-Agent
- Non-sensitive request/response headers

**Headers redacted in logs**
- `Authorization`
- `Cookie`
- `Set-Cookie`
- Known API-key and token-bearing headers such as `X-API-Key` and `X-Auth-Token`

Header matching is case-insensitive. Request and response bodies are not logged by the default HTTP logger middleware.

### CORS Configuration

The CORS policy is driven by the `CORS_ALLOWED_ORIGINS` environment variable, a comma-separated list of allowed origins.

```bash
# Allow specific origins
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

#### Behavior by environment

| Environment | Default | Behavior |
|---|---|---|
| `production` | Deny-by-default (empty allowlist) | Only origins in `CORS_ALLOWED_ORIGINS` are accepted. Wildcard (`*`) and localhost origins are rejected at startup. |
| `development` / `staging` / `test` | `http://localhost:3000,http://localhost:3001` | Localhost origins are pre-configured for convenience. Explicitly setting the variable overrides the default. |

#### Security guarantees

- The request `Origin` header is reflected in `Access-Control-Allow-Origin` **only** when it exists in the allowlist.
- Arbitrary origins are never echoed back.
- Wildcard (`*`) is never used as `Access-Control-Allow-Origin` because credentials are always enabled.
- `Access-Control-Allow-Credentials: true` is set for all allowlisted requests.
- Requests without an `Origin` header (server-to-server, curl, health checks) are allowed.

#### Allowed methods

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`

#### Allowed headers

`Content-Type`, `Authorization`

For detailed information, see [Security Documentation](docs/backend/security.md).

## Test Strategy

The test suite includes both unit and integration coverage:

1. Unit tests for validation, dedupe key construction, repository behavior, and processor semantics.
2. Integration-style tests for HTTP ingestion and persistence behavior through Express routes.
3. Failure-path tests for malformed payloads, duplicate replays, and unexpected processing errors.

Coverage thresholds are enforced in Jest at 95% for statements, branches, functions, and lines (for included modules).

## Queue Processor Logging Convention

All queue processors (`src/queue/processors/`) use the structured logger from `src/logger.ts` — **never** `console.log` / `console.warn` / `console.error`.

### Rules

| Concern | Rule |
|---|---|
| Logger instantiation | Each processor calls `createLogger({ processor: '<name>', ...correlationCtx })` at the top of its handler, binding `correlationId` and `requestId` from the job payload. |
| Log record shape | Every record carries `timestamp`, `level`, `message`, and `service: "talenttrust-backend"`. Processor-specific context (e.g. `processor`, `action`, `network`) is bound at logger creation time and appears on every record from that processor instance. |
| PII at info/warn level | Recipient email addresses, `userId`, and `contractId` must **not** appear in `message` strings at `info` or `warn` level. They may be logged at `debug` level as structured fields. |
| Sensitive payload fields | Any payload logged at debug level must pass through `redactObject` / `redactPayload` from `src/utils/redact.ts` before inclusion. Keys matching `secret`, `token`, `password`, `authorization`, `key`, `signature`, `cookie`, and `nonce` are automatically replaced with `[REDACTED]` by the logger's built-in sanitizer. |
| Error path | Validation errors emit a `warn` record (via `log.warn(...)`) **before** throwing, so observers can correlate the rejection with the job's correlation context. |
| Job IDs | Email tracking IDs are generated with `generateEmailId()` (uses `crypto.randomUUID()`). **Never** use `Date.now() + Math.random()` for IDs — this approach is collision-prone under load. |

### ID generation

`generateEmailId()` is exported from `email-processor.ts` and documented with TSDoc:

```ts
/**
 * Generate a cryptographically-strong unique tracking ID for an outbound email.
 *
 * Uses `crypto.randomUUID()` (RFC 4122 v4) so that IDs are collision-resistant
 * even under rapid successive calls, unlike the previous `Date.now() +
 * Math.random()` approach which could produce duplicates under load.
 *
 * @returns A UUID v4 string prefixed with `email_` for readability in logs.
 */
export function generateEmailId(): string {
  return `email_${crypto.randomUUID()}`;
}
```

Uniqueness is validated in tests by generating 50 IDs in rapid succession and asserting the full set is deduplicated.

### Example — adding a new processor

```ts
import { createLogger } from '../../logger';

export async function processMyJob(payload: MyPayload): Promise<JobResult> {
  const log = createLogger({
    processor: 'my-processor',
    ...(payload.correlationId && { correlationId: payload.correlationId }),
    ...(payload.requestId    && { requestId:    payload.requestId }),
  });

  if (!isValid(payload)) {
    log.warn('Validation failed: reason');   // structured, no PII in message
    throw new Error('...');
  }

  log.info('Job started');
  // log sensitive fields only at debug, never in message strings
  log.debug('Processing with context', { internalId: payload.id });
  log.info('Job completed', { someMetric: 42 });
  return { success: true };
}
```

### Log record example

```json
{
  "timestamp": "2026-07-24T22:52:00.001Z",
  "level": "info",
  "message": "Email notification delivered",
  "service": "talenttrust-backend",
  "processor": "email",
  "emailId": "email_3f1a2b4c-...",
  "subject": "Welcome",
  "correlationId": "corr-abc",
  "requestId": "req-123"
}
```

### Testing convention

Processor tests use `setWriteRecordImpl` from `src/logger.ts` to intercept log records as plain objects rather than parsing serialised output. This allows assertions on:

- Required base field presence (`timestamp`, `level`, `message`, `service`)
- Correlation context propagation (`correlationId`, `requestId`)
- PII absence in `info`/`warn` message strings (email addresses, `userId`, `contractId`)
- `warn` emission before throws on validation failure
- Unique ID generation across rapid successive calls


## Graceful shutdown and drain order

The service now uses a single shutdown registry for SIGTERM/SIGINT handling. On shutdown it performs the following steps in order:

1. Close the HTTP listener so new requests stop arriving.
2. Stop accepting new webhook deliveries and wait for in-flight deliveries, with a bounded grace period before fallback checkpointing.
3. Stop accepting new transaction polls and queue jobs, wait for in-flight work to finish, and checkpoint any remaining pending state if the grace period expires.
4. Close BullMQ workers and downstream connections before exiting.

This prevents polls and queue jobs from being interrupted mid-flight while preserving a checkpointable state for pending work.

## Security Notes

1. Input validation is strict at ingestion boundaries to reject malformed payloads early.
2. Replay and duplicate delivery are handled as idempotent outcomes using a deterministic dedupe key.
3. JSON body limit is constrained to reduce accidental oversized request risk.
4. Current persistence is in-memory and intended for testability and local development; production hardening should add durable storage and capacity limits.
5. Trust boundary remains the ingestion endpoint; event authenticity and signature verification are future integration concerns.

All configuration is managed through `src/config/` and validated at startup using **Zod**. This ensures a fail-fast behavior with clear error messages. Copy `.env.example` to `.env` to get started. See [docs/backend/config.md](docs/backend/config.md) for full details.

| Variable | Default | Description |
|---|---|---|---|
| `PORT` | `3001` | HTTP port for the Express server |
| `NODE_ENV` | `development` | Runtime environment (`development`, `staging`, `production`, `test`) |
| `API_BASE_URL` | `http://localhost:${PORT}` | Base URL for the API |
| `DEBUG` | `false` | Enable/disable debug logging |
| `CORS_ALLOWED_ORIGINS` | *(see CORS Configuration)* | Comma-separated list of allowed CORS origins. In production defaults to deny-by-default; in development defaults to `http://localhost:3000`. |
| `DATABASE_URL` | *(optional)* | Database connection string |
| `JWT_SECRET` | *(optional)* | Secret used for JWT signing (min 8 chars) |
| `IDEMPOTENCY_TTL_MS` | `3600000` | Idempotency key TTL in ms (default 1 hour); after expiry keys are eligible for eviction and re-submission is processed fresh |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Stellar Horizon API endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network passphrase for signing |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban JSON-RPC endpoint |
| `SOROBAN_CONTRACT_ID` | *(empty)* | Deployed escrow contract ID |
| `ACTIVE_COLOR` | `blue` | Active backend color for blue-green routing |
| `BLUE_PORT` | `3001` | Port for the 'blue' backend |
| `GREEN_PORT` | `3002` | Port for the 'green' backend |
| `HTTP_METRICS_ROUTE_LABEL_LIMIT` | `100` | Maximum distinct HTTP route template labels before new routes are recorded as `other` |

## Webhooks Feature Flag

| Variable | Default | Description |
|---|---|---|
| `WEBHOOKS_ENABLED` | `true` | Enable/disable the webhooks subsystem at runtime. When `false`, `WebhookService.trigger()` becomes a no-op (no subscriptions queried, no deliveries attempted, no DLQ writes), and the `/api/v1/webhook-subscriptions` router is not mounted (all subscription management endpoints return `404`). Omit the variable to keep webhooks enabled (safe default). |

See [docs/webhooks.md](docs/webhooks.md) for full webhook documentation and [docs/backend/config.md](docs/backend/config.md) for all configuration options.

## Milestones Feature Flag

| Variable | Default | Description |
|---|---|---|
| `MILESTONES_ENABLED` | `true` | Enable/disable the milestones feature at runtime. When `false`, any `milestones` field in a contract create/update request is silently stripped — no validation errors are raised. Omit the variable to keep the feature enabled (safe default). |

See [docs/milestones.md — Feature Flag](docs/milestones.md#feature-flag-milestones_enabled) for full details.


## API Endpoints

### Health Check

The service exposes a comprehensive health check endpoint at `GET /health` that aggregates dependency probes.

**Request:**
```bash
curl http://localhost:3000/health
```

**Response (200 OK - healthy):**
```json
{
  "status": "ok",
  "service": "talenttrust-backend",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptimeSeconds": 1234,
  "probes": [
    {
      "name": "db",
      "ok": true,
      "status": "up",
      "latencyMs": 45
    },
    {
      "name": "redis",
      "ok": true,
      "status": "up",
      "latencyMs": 12
    }
  ]
}
```

**Response (503 Service Unavailable - degraded):**
```json
{
  "status": "degraded",
  "service": "talenttrust-backend",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptimeSeconds": 1234,
  "probes": [
    {
      "name": "db",
      "ok": false,
      "status": "down",
      "detail": "disk I/O error",
      "latencyMs": 5000
    }
  ]
}
```

**Probe Status Mapping:**

Each probe reports one of three statuses:

| Status | Meaning | HTTP |
|--------|---------|------|
| `up` | Dependency is healthy and responsive | 200 |
| `degraded` | Dependency is slow or warning | 503 |
| `down` | Dependency is unreachable or failed | 503 |

**Database Probe (`db`):**
- Verifies SQLite connectivity with lightweight `SELECT 1` query
- Thresholds: up (<1000ms), degraded (1000-3000ms), down (≥3000ms or error)
- Security: Query is hardcoded with no user input
- Configuration: `DB_BUSY_TIMEOUT` (default 5000ms)

**Redis Probe (`redis`):**
- Tests Redis with PING command
- Timeout: 3000ms
- Configuration: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`

**Other Probes:**
- `stellar-rpc`: Stellar/Soroban RPC reachability (5s timeout)
- `queue`: BullMQ job queue health (degraded if failed jobs exceed
  `QUEUE_FAILED_THRESHOLD` or waiting backlog exceeds
  `QUEUE_BACKLOG_THRESHOLD`; configurable via validated config)
- `circuit-breaker`: Reports open circuit breakers (degraded if any
  breaker is in OPEN state)
- `env`: Verifies required environment variables

**Production Security:**

In production (NODE_ENV=production), probe details are stripped to prevent topology leakage to unauthenticated callers.

### Metrics Cardinality Guard

HTTP metrics use Express route templates for the `route` label, for example
`/api/v1/contracts/:id`, instead of concrete request paths with embedded user
or resource identifiers. Unmatched requests are recorded as `unmatched`.

`HTTP_METRICS_ROUTE_LABEL_LIMIT` caps the number of distinct route template
labels retained by `http_requests_total` and `http_request_duration_seconds`.
After the cap is reached, newly observed route templates are recorded as
`other`, while existing route labels, `method`, and `status_code` remain intact.

### Contracts
- `GET /api/v1/contracts` - List contracts (placeholder)

### Contract Metadata
- `POST /api/v1/contracts/:contractId/metadata` - Create metadata
- `GET /api/v1/contracts/:contractId/metadata` - List metadata with pagination
- `GET /api/v1/contracts/:contractId/metadata/:id` - Get single metadata
- `PATCH /api/v1/contracts/:contractId/metadata/:id` - Update metadata
- `DELETE /api/v1/contracts/:contractId/metadata/:id` - Delete metadata

See [docs/backend/contract-metadata-api.md](docs/backend/contract-metadata-api.md) for detailed API documentation.

## Authentication

The API uses Bearer token authentication. Include the token in the Authorization header:

```
Authorization: Bearer <your-auth-token>
```

Demo tokens for testing:
- `demo-admin-token` - Admin user with full access
- `demo-user-token` - Regular user with limited access

## Authentication & Authorization

The API uses **Role-Based Access Control (RBAC)** with four roles: `admin`,
`freelancer`, `client`, and `guest`. Protected endpoints require a
`Bearer <token>` header.

See [docs/backend/authentication-authorization.md](docs/backend/authentication-authorization.md)
for the full access control matrix, architecture, and security notes.

For API key authentication (used by internal/external service integrations), see [docs/api-keys.md](docs/api-keys.md) for the complete lifecycle, scope reference, and rotation guidance.

## Request Validation Framework

The API now includes a schema-based request validation framework for:

- Route `params`
- URL `query`
- JSON request `body`

Validation behaviour:

- Unknown fields are stripped.
- Required fields are enforced.
- Type and range/length constraints are validated.

Validation middleware returns HTTP `400` with the shape:

```json
{
	"error": "Validation failed",
	"details": ["query.admin is not allowed"]
}
```

See `docs/backend/request-validation-framework.md` for implementation details and security notes.

## Documentation

- [SLA/SLO Definitions and Alert Thresholds](docs/backend/SLA_SLO.md)

## Contributing

1. Fork the repo and create a branch: `git checkout -b feature/<ticket>-description`
2. Make changes, run `npm run lint && npm run test:ci && npm run build`
3. Open a pull request — CI runs all four gates automatically

## Database

The backend uses an embedded **SQLite** database (via `better-sqlite3`) — no external service required.

| Environment variable | Default          | Description                                                 |
| -------------------- | ---------------- | ----------------------------------------------------------- |
| `DB_PATH`            | `talenttrust.db` | Path to the SQLite file. Use `:memory:` for ephemeral mode. |

Schema migrations run automatically on startup and record applied versions in `schema_version`. See [`docs/backend/database.md`](docs/backend/database.md) for full documentation: schema, versioning, rollback guidance, repository API, configuration, and security notes.

## Circuit Breaker

Upstream RPC calls (Stellar/Soroban) are protected by a built-in circuit breaker.

| State       | Behaviour                                          |
| ----------- | -------------------------------------------------- |
| `CLOSED`    | Normal operation                                   |
| `OPEN`      | Fast-fail — returns `503` without calling upstream |
| `HALF_OPEN` | Single probe; success → CLOSED, failure → OPEN     |

| Environment variable | Default                               | Description               |
| -------------------- | ------------------------------------- | ------------------------- |
| `STELLAR_RPC_URL`    | `https://soroban-testnet.stellar.org` | Stellar JSON-RPC endpoint |

Live state is available at `GET /api/v1/circuit-breaker/status`. See [`docs/backend/circuit-breaker.md`](docs/backend/circuit-breaker.md) for full reference.

## Blockchain Sync

The `blockchain-sync` background job ingests on-chain Soroban contract events
into the local indexer. It scans a ledger range, fetches events from the
Soroban RPC layer, and persists each event so downstream consumers (reputation,
escrow flows) see the latest chain state.

| Behaviour | Detail |
| --------- | ------ |
| **Real RPC ingestion** | Events are fetched via `SorobanRpcService.getEvents` (no more stubbed batches). |
| **Idempotent persistence** | Each event is keyed by `contractId:eventId:ledger`; replayed or retried batches never double-write. |
| **Circuit-breaker guarded** | Every RPC call runs through the shared breaker; an open circuit fast-fails the job. |
| **Resumable** | Progress is checkpointed per batch via a cursor, so a restarted job resumes from the last synced ledger instead of re-scanning from zero. |
| **Fail-and-retry** | RPC/timeout errors throw so the queue retries the job rather than silently reporting success. |
| **SSRF-guarded** | `SOROBAN_RPC_URL` is validated against the SSRF allow-list before any egress. |

Job payload (`BlockchainSyncPayload`):

```jsonc
{
  "network": "soroban",   // or "stellar"
  "startBlock": 1000,      // optional — resumes from the last cursor when omitted
  "endBlock": 1100         // optional — defaults to the current chain head
}
```

| Environment variable | Default | Description |
| -------------------- | ------- | ----------- |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban JSON-RPC endpoint (must be a public, SSRF-safe URL). |
| `SOROBAN_CONTRACT_ID` | *(empty)* | When set, events are filtered to this contract. |

When neither `startBlock` nor a stored cursor exists, the job starts from ledger
`0`; when `endBlock` is omitted, the current chain head is discovered via
`getLatestLedger`. If there is nothing new to sync, the job returns early
without making event calls.

## Blockchain Finality Depth

Consumers must not observe on-chain state (e.g. a `MILESTONE_RELEASED`
release) before it is settled: a reorg before finality would otherwise serve
contradictory state. The backend therefore gates **public reads** on a
per-network confirmation depth.

- Events ingested with `network` + `ledger` are evaluated against the chain
  head. Below the network's depth they are stored internally as
  `provisional` and hidden from public reads (e.g. contract history).
- A promotion sweep re-evaluates provisional events after every successful
  blockchain sync and flips them to `finalized` once they reach the depth.
  Promotion is one-way and idempotent, so retries and reorgs before finality
  are safe.
- Off-chain events (no `ledger`) and zero-confirmation networks are exposed
  immediately.
- Operators observe pending state only via the admin endpoint
  `GET /api/v1/admin/events/provisional` (admin role required; payloads are
  never included).

| Variable | Default | Description |
|---|---|---|
| `FINALITY_DEPTHS` | `stellar=1,soroban=1` | Comma-separated `network=depth` confirmation depths. `network=0` enables zero-confirmation for that network. |
| `FINALITY_DEFAULT_DEPTH` | `6` | Conservative depth applied to networks without an explicit entry (fail-closed). |
| `FINALITY_ALLOW_ZERO_CONFIRMATION` | *(env-dependent)* | When `true`, depth `0` is honoured; when `false` it is clamped to `1`. Unset → allowed in development/test/staging, forbidden in production. |

See [docs/backend/finality.md](docs/backend/finality.md) for full semantics,
edge cases, and operational/security decisions.

## New Features

### 1. Authentication Middleware (#55)
All routes under `/api/v1/admin/*` are protected by JWT authentication.
- **Header**: `Authorization: Bearer <token>`
- **Validation**: Ensures token is valid and not expired.

### 2. Event Idempotency (#67)
The `/api/v1/events` endpoint requires an `Idempotency-Key` header to prevent duplicate processing of the same smart contract event.
- **Header**: `Idempotency-Key: <unique-uuid-or-hash>`
- **Behavior**: If a key is seen again within 1 hour, the cached response is returned instead of re-processing.

### 3. Smart-Contract Event Indexer (#70)
A pipeline for indexing escrow and dispute lifecycle updates from smart contracts.
- **Endpoint**: `POST /api/v1/events`
- **Supported Events**: `escrow:created`, `escrow:completed`, `dispute:initiated`, `dispute:resolved`.

### 4. Request Context Propagation via AsyncLocalStorage
A request-scoped storage utility backed by Node.js `AsyncLocalStorage` to automatically propagate `requestId` and `correlationId` context fields down the async execution tree.
- **Middleware**: The `requestContext` middleware seeds the store with `requestId` and optional `correlationId` parsed from HTTP headers (`X-Request-Id` and `X-Correlation-Id`).
- **Observability**: The global `Logger` automatically reads from this store when logging, ensuring logs emitted by downstream services, repository queries, and operations carry the correct correlation context without manual parameter passing.
- **Safety**: Safe defaults (no IDs) are provided when running outside of a request context (e.g. background tasks or scheduled jobs), and request contexts are concurrently isolated to prevent cross-request context leakage.

## Testing

Run unit and integration tests to verify these features:
```bash
npm test
```

## Secrets Management

TalentTrust Backend follows a strict policy for handling secrets. All sensitive information must be managed through the `SecretsManager`.

For more information, see the [Secrets Handling Documentation](docs/backend/secrets-handling.md).

## License

MIT

## -------------- Utilities  ------------

## Transaction Poller

The `TransactionPoller` service manages blockchain transaction confirmations using an exponential backoff strategy.

### Features
- **Configurable Retries**: Set `maxRetries` to limit the number of backoff polling attempts.
- **Duration Ceiling**: An absolute wall-clock duration limit (`maxTotalDurationMs`) can be set as a circuit breaker. If the transaction takes longer than this ceiling, polling is halted and the transaction transitions to `TIMEOUT`. This acts as an absolute guard and takes precedence over `maxRetries` if reached first.
- **Idempotent Polling**: Safely restarts after an app crash without duplicating tracking logic.

### Transaction Persistence Model

Transaction state is persisted in SQLite through the `transactions` table, keyed by transaction hash. The store is exposed via the `TransactionsDbInterface` with two implementations:

| Implementation | Backing store | Feature flag |
|---|---|---|
| `SqliteTransactionStore` | SQLite `transactions` table via `better-sqlite3` | `USE_SQLITE_TRANSACTION_STORE=true` (default) |
| `InMemoryTransactionStore` | In-memory `Map` | `USE_SQLITE_TRANSACTION_STORE=false` |

The `TransactionPoller` accepts an optional `store` parameter in its constructor. When omitted, it uses the global `transactionsDb` instance, which is created by the factory function `createTransactionsDb()` based on the `USE_SQLITE_TRANSACTION_STORE` environment variable.

#### Stored columns

| Column | Type | Description |
|---|---|---|
| `hash` | `TEXT PRIMARY KEY` | Blockchain transaction hash |
| `status` | `TEXT` | One of `PENDING`, `SUCCESS`, `FAILED`, `TIMEOUT` |
| `receipt` | `TEXT` (JSON) | Full blockchain receipt, serialised as JSON |
| `last_checked_at` | `TEXT` (ISO-8601) | Timestamp of the last poll attempt |
| `retry_count` | `INTEGER` | Number of retries performed |
| `started_at` | `TEXT` (ISO-8601) | When polling for this transaction began |

#### SQLite storage behaviour

- All queries use **parameterised prepared statements** — receipt JSON and other values are never interpolated into SQL strings.
- Receipt data is serialised with `JSON.stringify` on write and parsed with a safe wrapper (`try/catch` around `JSON.parse`) on read. Malformed receipts are returned as `undefined` rather than crashing the caller.
- The `INSERT ... ON CONFLICT(hash) DO UPDATE` pattern ensures that repeated calls to `set()` update the existing row without creating duplicates.
- Schema migrations are handled by `src/db/migrations.ts` (versions 5 and 9 create the `transactions` table and add the `started_at` column).

#### Restart recovery flow

On application startup, call `recoverPendingTransactions()` to rehydrate in-flight polling:

1. Load all rows from the `transactions` table where `status = 'PENDING'`.
2. For each pending transaction, restore `retry_count` and `last_checked_at`.
3. Resume the polling loop from the current retry index using `calculateDelay` from `src/utils/retry.ts`.
4. Terminal transactions (`SUCCESS`, `FAILED`, `TIMEOUT`) are **not** reloaded — they remain in the database for audit but are excluded from recovery.

### Security

- **Parameterised SQL**: All queries use `?` placeholders. Receipt JSON is passed as a bound parameter, never concatenated.
- **Corrupted receipts**: `safeParseReceipt` wraps `JSON.parse` in a try-catch. If a stored receipt is malformed, the field returns `undefined` and the transaction is handled safely.
- **Fail closed**: A `get()` that throws (e.g., database I/O error) returns `undefined` rather than propagating the exception to the poller.

## Retry & Backoff Utilities

Reusable retry policies for handling transient failures, located in `src/utils/retry.ts`.

### Usage
```typescript
import { withRetry } from './utils/retry';

const data = await withRetry(() => fetchFromApi(), {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  jitter: true,
});
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxAttempts` | number | 3 | Maximum retry attempts |
| `baseDelayMs` | number | 200 | Base delay in ms |
| `maxDelayMs` | number | 5000 | Max delay cap in ms |
| `jitter` | boolean | true | Adds randomness to delay |
| `isRetryable` | function | `() => true` | Controls which errors retry |


## Optimistic Concurrency Control (OCC)

Contract updates enforce optimistic concurrency via a monotonically increasing
version column on the contracts table. This prevents lost-update anomalies
when two clients edit the same contract concurrently.


# How it works
Read: GET /api/v1/contracts/:id returns the current version (starts at 0).
Update: PATCH /api/v1/contracts/:id must include the version you last read.
Atomic check: The database updates the row only if version matches;
otherwise a 409 ERR_CONFLICT is returned.
Version bump: On success the stored version is incremented by 1 atomically.

## Request / response examples
Successful update:
curl -X PATCH http://localhost:3001/api/v1/contracts/abc-123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-user-token" \
  -d '{"version": 0, "title": "Updated Title"}'
  {
  "status": "success",
  "data": {
    "id": "abc-123",
    "title": "Updated Title",
    "version": 1,
    ...
  }
}

Stale version (another client updated first):
curl -X PATCH http://localhost:3001/api/v1/contracts/abc-123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-user-token" \
  -d '{"version": 0, "title": "Late Update"}'
  {
  "error": {
    "code": "ERR_CONFLICT",
    "message": "Version conflict",
    "requestId": "..."
  }
}
Missing version:
{
  "error": {
    "code": "ERR_MISSING_VERSION",
    "message": "version field is required for updates",
    "requestId": "..."
  }
}
Invalid version:
{
  "error": {
    "code": "ERR_INVALID_VERSION",
    "message": "version must be a non-negative integer",
    "requestId": "..."
  }
}

## Security guarantees
The version check is enforced at the database level via a single atomic
UPDATE ... WHERE version = ? statement. It cannot be bypassed by omitting
the version field — the API layer rejects such requests with 400 ERR_MISSING_VERSION.
The version counter is a non-negative integer that starts at 0 and increments
by exactly 1 on every successful update.
