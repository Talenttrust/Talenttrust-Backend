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
