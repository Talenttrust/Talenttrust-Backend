# TalentTrust Backend

Express API for the TalentTrust decentralized freelancer escrow protocol. Handles contract metadata, reputation, and integration with Stellar/Soroban.

## Runtime Configuration Toggles

The backend now supports validated feature flags for controlled rollout of higher-risk routes. Runtime configuration is loaded once at process boot, and invalid values fail startup instead of silently enabling unexpected behavior.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | HTTP port for the Express server |
| `FEATURE_CONTRACTS_API_ENABLED` | `true` | Enables the `/api/v1/contracts` route while preserving current default behavior |
| `FEATURE_RUNTIME_CONFIG_ENDPOINT_ENABLED` | `false` | Enables the `/api/v1/runtime-config` diagnostics route |

Accepted boolean values: `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off` (case-insensitive).

### Example

```bash
FEATURE_CONTRACTS_API_ENABLED=false \
FEATURE_RUNTIME_CONFIG_ENDPOINT_ENABLED=true \
npm run dev
```

When a feature is disabled, the backend responds with `404` and a `feature_disabled` payload. This keeps dark-launched routes non-discoverable to normal clients while leaving `/health` available for orchestration and uptime checks.

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

## Runtime Toggle Documentation

Reviewer-focused implementation notes, threat scenarios, and operational guidance live in [`docs/backend/runtime-configuration-toggles.md`](docs/backend/runtime-configuration-toggles.md).

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
