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

## Contributing

1. Fork the repo and create a branch: `git checkout -b feature/<ticket>-description`
2. Make changes, run `npm run lint && npm run test:ci && npm run build`
3. Open a pull request — CI runs all four gates automatically

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