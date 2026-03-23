# TalentTrust Backend

Express API for the TalentTrust decentralized freelancer escrow protocol. Handles contract metadata, reputation, and integration with Stellar/Soroban.

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
