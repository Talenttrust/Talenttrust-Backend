# TalentTrust Backend

Express API for the TalentTrust decentralized freelancer escrow protocol. Handles contract metadata, reputation, and integration with Stellar/Soroban.

## Prerequisites

- Node.js 18+
- npm or yarn

## Setup

```bash
# Clone and enter the repo
git clone <your-repo-url>
cd talenttrust-backend

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Start dev server (with hot reload)
npm run dev

# Start production server
npm start
```

## Scripts

| Script   | Description                    |
|----------|--------------------------------|
| `npm run build` | Compile TypeScript to `dist/`  |
| `npm run start` | Run production server          |
| `npm run dev`   | Run with ts-node-dev           |
| `npm test`      | Run Jest tests                 |
| `npm run lint`  | Run ESLint                     |

## Cache layer

The backend now includes a small in-memory cache layer for safe read-mostly contract lookups.

Cached flows:

- `GET /api/v1/contracts`
- `GET /api/v1/contracts/:id`

These cover the current read-heavy route and metadata lookup behavior in the repo.

### Strategy

- cache backend: in-memory
- default TTL: `30` seconds
- default max items: `100`
- invalidation: explicit invalidation of affected list/detail keys after `POST /api/v1/contracts`
- fallback: cache failures fall back to the source-of-truth service without failing the request

### Configuration

Environment variables:

- `CACHE_ENABLED` (default `true`)
- `CACHE_TTL_SECONDS` (default `30`)
- `CACHE_MAX_ITEMS` (default `100`)

### Security notes

- only shared read-mostly contract data is cached
- no auth/session/token data is cached
- no authorization results are cached
- cache keys are deterministic and normalized
- cache backend failures do not override source-of-truth correctness

### Threat scenarios validated

- stale read cache after writes
- cache backend read/write failure
- unbounded in-memory growth through item limit and TTL
- key collision risk reduced by explicit namespacing

## Integration tests

The backend includes a focused integration test suite covering representative API behavior for:

- `GET /health`
- `GET /api/v1/contracts`
- `GET /api/v1/contracts/:id`
- `POST /api/v1/contracts`

The tests verify:

- success paths
- malformed JSON handling
- validation failures
- duplicate creation conflicts
- not found and unsupported route behavior
- internal error sanitization
- cache hit/miss, invalidation, disabled-cache mode, and cache-failure fallback
- server bootstrap/start-stop behavior

### Test architecture

To keep tests deterministic and reviewer-friendly:

- `src/app.ts` creates the Express app without listening
- `src/index.ts` only starts the HTTP server
- `ContractService` uses per-app in-memory state for tests
- no external services or production systems are contacted

### Security and threat assumptions validated

- malformed input is rejected early
- invalid identifiers do not proceed to resource lookup
- duplicate resource creation is blocked
- self-dealing contract creation is denied
- internal errors are sanitized and do not leak stack traces
- integration tests do not depend on live external systems

### Documentation

Detailed backend test notes live in:

- `docs/backend/integration-testing.md`
- `docs/backend/cache-layer.md`
- `docs/backend/webhook-ingestion.md`

## Webhook ingestion

The backend now includes a signed blockchain webhook intake endpoint:

- `POST /webhooks/blockchain`

The endpoint verifies the webhook signature against the exact raw request body before parsing or processing the event.

### Signature and headers

By default the route expects:

- `X-Webhook-Signature`
- `X-Webhook-Timestamp`
- `X-Webhook-Id`

The signature is an HMAC-SHA256 digest of:

```text
<timestamp>.<raw-request-body>
```

The shared secret is loaded from `WEBHOOK_SECRET`.

### Supported events

The current supported normalized event types are:

- `contract.metadata.updated`
- `contract.payment.released`

Unknown event types are rejected safely.

### Replay and idempotency

The webhook layer currently protects against replay and duplicate delivery by:

- rejecting timestamps older than the configured max age
- reserving delivery ids during processing
- acknowledging already processed delivery ids without re-running the handler
- releasing failed deliveries so provider retries can succeed

### Configuration

Environment variables:

- `WEBHOOK_SECRET`
- `WEBHOOK_SIGNATURE_HEADER` default `x-webhook-signature`
- `WEBHOOK_TIMESTAMP_HEADER` default `x-webhook-timestamp`
- `WEBHOOK_EVENT_ID_HEADER` default `x-webhook-id`
- `WEBHOOK_MAX_AGE_SECONDS` default `300`
- `WEBHOOK_RAW_BODY_LIMIT` default `64kb`

### Security notes

- signature verification uses the raw request body, not reserialized JSON
- constant-time digest comparison is used
- unsigned, malformed, tampered, and stale requests are rejected before processing
- duplicate deliveries are handled idempotently
- oversized payloads are rejected with `413`
- responses do not expose secrets, signatures, or internal stack traces

### Test coverage

The webhook tests cover:

- valid signature acceptance
- missing, malformed, invalid, and stale signature rejection
- raw-body verification behavior
- duplicate delivery handling
- malformed JSON and unsupported events
- processing-failure sanitization
- missing configuration and oversized payload handling

## Contributing

1. Fork the repo and create a branch from `main`.
2. Install deps, run tests and build: `npm install && npm test && npm run build`.
3. Open a pull request. CI runs build (and tests when present) on push/PR to `main`.

## CI/CD

GitHub Actions runs on push and pull requests to `main`:

- Install dependencies
- Build the project (`npm run build`)

Keep the build passing before merging.

## License

MIT
