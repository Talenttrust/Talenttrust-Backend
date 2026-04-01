# TalentTrust Backend

Express API for the TalentTrust decentralized freelancer escrow protocol.
Handles contract metadata, reputation, and integration with Stellar/Soroban.

## Features

- **Queue-Based Background Jobs**: Durable job processing with BullMQ and Redis
- **Contract Processing**: Asynchronous blockchain contract operations
- **Email Notifications**: Non-blocking email delivery
- **Reputation System**: Background reputation score calculations
- **Blockchain Sync**: Efficient blockchain data synchronization

## Dependency Chaos Testing

The backend includes dependency-level chaos testing to simulate upstream outages and verify graceful degradation.

### Behavior

- `GET /api/v1/contracts` returns upstream data during normal operation.
- On upstream failures with graceful degradation enabled, it returns a safe fallback payload with `degraded: true`.
- If graceful degradation is disabled, it returns `503` with `contracts_unavailable`.

### Configuration

- `GRACEFUL_DEGRADATION_ENABLED=true|false` (default `true`)
- `UPSTREAM_CONTRACTS_URL` (default `https://example.invalid/contracts`)
- `UPSTREAM_TIMEOUT_MS` (default `1200`, bounded to `100..10000`)
- `CHAOS_MODE=off|error|timeout|random` (default `off`)
- `CHAOS_TARGETS` (comma-separated dependencies like `contracts`)
- `CHAOS_PROBABILITY` (float `0..1`, used by `random` mode)

### Docs

Detailed architecture and security notes are in `docs/backend/chaos-testing.md`.

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

Detailed notes are in `docs/backend/error-handling.md`.

## Features

- **Smart Contract Integration**: Handles contract metadata and lifecycle management
- **Reputation System**: Tracks and manages freelancer reputation
- **Data Retention Controls**: Configurable compliance-ready data retention and archival
- **Audit Logging**: Complete audit trail for compliance verification
- **GDPR/CCPA Ready**: Built-in support for major compliance frameworks

## Contract Event Processing

The backend now includes a deterministic contract event processing pipeline focused on three semantics:

1. Ingestion: validate inbound event payloads before business processing.
2. Deduplication: compute a stable event identity key (`contractId:eventId:sequence`) and treat replays as idempotent duplicates.
3. Persistence: store accepted events through a repository abstraction (current implementation: in-memory).

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health |
| `POST` | `/api/v1/contracts/events` | Ingest contract event payload |
| `GET` | `/api/v1/contracts/events` | List persisted events |
| `GET` | `/api/v1/contracts` | List unique contract ids from persisted events |

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

## Documentation
- [Backend Notification Services](./docs/backend/notifications.md)

## CI/CD

GitHub Actions runs four gates on every push and pull request to `main`:

1. **Lint** — ESLint with TypeScript-aware rules
2. **Test** — Jest with ≥95% line/function/statement coverage
3. **Build** — TypeScript strict compilation (runs after lint + test pass)
4. **Security Audit** — `npm audit --audit-level=high`

All four checks must pass before a PR can be merged. See
[docs/backend/branch-protection.md](docs/backend/branch-protection.md) for
the recommended GitHub branch protection settings.

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
- **CORS Policy**: Configurable origin controls.

For detailed information, see [Security Documentation](docs/backend/security.md).

## Test Strategy

The test suite includes both unit and integration coverage:

1. Unit tests for validation, dedupe key construction, repository behavior, and processor semantics.
2. Integration-style tests for HTTP ingestion and persistence behavior through Express routes.
3. Failure-path tests for malformed payloads, duplicate replays, and unexpected processing errors.

Coverage thresholds are enforced in Jest at 95% for statements, branches, functions, and lines (for included modules).

## Security Notes

1. Input validation is strict at ingestion boundaries to reject malformed payloads early.
2. Replay and duplicate delivery are handled as idempotent outcomes using a deterministic dedupe key.
3. JSON body limit is constrained to reduce accidental oversized request risk.
4. Current persistence is in-memory and intended for testability and local development; production hardening should add durable storage and capacity limits.
5. Trust boundary remains the ingestion endpoint; event authenticity and signature verification are future integration concerns.

## Environment Variables

All configuration is managed through `src/config/` and validated at startup. Copy `.env.example` to `.env` to get started. See [docs/backend/config.md](docs/backend/config.md) for full details.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port for the Express server |
| `NODE_ENV` | `development` | Runtime environment |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Stellar Horizon API endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network passphrase for signing |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban JSON-RPC endpoint |
| `SOROBAN_CONTRACT_ID` | *(empty)* | Deployed escrow contract ID |

## API Endpoints

- `GET /health` - Health check
- `GET /api/v1/contracts` - Get contracts
- `GET /api/v1/reputation/:id` - Get freelancer reputation profile
- `PUT /api/v1/reputation/:id` - Update freelancer reputation profile

See [docs/backend/reputation-api.md](docs/backend/reputation-api.md) for detailed Reputation API info.

## API Endpoints

### Health Check
- `GET /health` - Service health status

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

## Contributing

1. Fork the repo and create a branch: `git checkout -b feature/<ticket>-description`
2. Make changes, run `npm run lint && npm run test:ci && npm run build`
3. Open a pull request — CI runs all four gates automatically

## Database

The backend uses an embedded **SQLite** database (via `better-sqlite3`) — no external service required.

| Environment variable | Default          | Description                                                 |
| -------------------- | ---------------- | ----------------------------------------------------------- |
| `DB_PATH`            | `talenttrust.db` | Path to the SQLite file. Use `:memory:` for ephemeral mode. |

Schema migrations run automatically on startup. See [`docs/backend/database.md`](docs/backend/database.md) for full documentation: schema, repository API, configuration, and security notes.

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

## License

MIT

## -------------- Utilities  ------------
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
