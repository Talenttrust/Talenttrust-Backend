# TalentTrust Backend

Express API for the TalentTrust decentralized freelancer escrow protocol. Handles contract metadata, reputation, and integration with Stellar/Soroban.

## Incident Response Playbook

The backend now exposes responder-ready incident runbooks for outage triage, recovery, and postmortems.

- `GET /api/v1/incident-response` returns the available runbook summaries
- `GET /api/v1/incident-response/:runbookId` returns a full runbook
- Supported runbooks: `api-outage`, `data-integrity`, `security-breach`

Detailed reviewer-oriented documentation lives in [docs/backend/incident-response-playbook.md](/Users/mac/Documents/github/wave/Talenttrust-Backend/docs/backend/incident-response-playbook.md).

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

## Security Notes

- Runbook identifiers are validated to accept only lowercase letters, numbers, and hyphens.
- Recovery guidance explicitly avoids bypassing authentication, rate limiting, and audit controls.
- Security-sensitive incidents require evidence preservation, least-privilege recovery access, and controlled communications.

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
