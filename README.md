# TalentTrust Backend

Express API for the TalentTrust decentralized freelancer escrow protocol. Handles contract metadata, reputation, and integration with Stellar/Soroban.

## Features

- **Versioned API**: Stable URL-based versioning with deprecation policy
- **Multiple Version Detection**: URL path, Accept header, and query parameter support
- **Deprecation Management**: RFC-compliant deprecation headers and sunset dates
- **Comprehensive Testing**: 95%+ test coverage with unit and integration tests
- **Type Safety**: Full TypeScript implementation with strict mode
- **Modular Architecture**: Clean separation of concerns with versioned routes

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
npm test:coverage

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
| `npm run test:coverage` | Run tests with coverage report |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint`  | Run ESLint                     |

## API Versioning

### Supported Versions

- **v1**: Deprecated (sunset: 2024-12-31)
- **v2**: Active (current)

### Version Detection

The API supports multiple methods for version detection:

1. **URL Path** (Primary)
   ```
   GET /api/v1/contracts
   GET /api/v2/contracts
   ```

2. **Accept Header** (Secondary)
   ```bash
   curl -H "Accept: application/vnd.talenttrust.v2+json" \
     http://localhost:3001/api/contracts
   ```

3. **Query Parameter** (Tertiary)
   ```
   GET /api/contracts?version=v2
   ```

### Deprecation Headers

Deprecated endpoints include RFC-compliant headers:

```http
Deprecation: true
Sunset: Wed, 31 Dec 2024 23:59:59 GMT
Link: </api/v2/contracts>; rel="successor-version"
X-API-Deprecation-Warning: Migration guidance message
```

For detailed versioning documentation, see [docs/backend/API_VERSIONING.md](docs/backend/API_VERSIONING.md)

## API Endpoints

### Health Check

```bash
GET /health
```

Response:
```json
{
  "status": "ok",
  "service": "talenttrust-backend",
  "version": "v1",
  "timestamp": "2024-03-24T12:00:00.000Z"
}
```

### Contracts API v1 (Deprecated)

```bash
GET /api/v1/contracts
GET /api/v1/contracts/:id
```

### Contracts API v2 (Current)

```bash
GET /api/v2/contracts?status=active&limit=20
GET /api/v2/contracts/:id
```

## Project Structure

```
talenttrust-backend/
├── src/
│   ├── config/
│   │   ├── environment.ts       # Environment configuration
│   │   └── environment.test.ts
│   ├── routes/
│   │   ├── v1/
│   │   │   └── contracts.ts     # v1 contract endpoints
│   │   └── v2/
│   │       └── contracts.ts     # v2 contract endpoints
│   ├── versioning/
│   │   ├── types.ts             # Type definitions
│   │   ├── extractor.ts         # Version extraction logic
│   │   ├── deprecation.ts       # Deprecation management
│   │   ├── middleware.ts        # Express middleware
│   │   ├── index.ts             # Module exports
│   │   └── *.test.ts            # Unit tests
│   ├── index.ts                 # Application entry point
│   └── index.test.ts            # Integration tests
├── docs/
│   └── backend/
│       └── API_VERSIONING.md    # Versioning documentation
├── coverage/                     # Test coverage reports
├── dist/                         # Compiled JavaScript
├── jest.config.js               # Jest configuration
├── tsconfig.json                # TypeScript configuration
└── package.json                 # Dependencies and scripts
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage report
npm test:coverage

# Run in watch mode
npm run test:watch
```

### Coverage Requirements

- Minimum 95% coverage for all modules
- Unit tests for all versioning logic
- Integration tests for all API endpoints
- Edge case and error scenario coverage

### Test Output

```bash
Test Suites: 6 passed, 6 total
Tests:       50+ passed, 50+ total
Coverage:    95%+ lines, branches, functions, statements
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |
| `NODE_ENV` | development | Environment mode |
| `API_VERSION` | v1 | Default API version |
| `DEPRECATION_WARNING_DAYS` | 90 | Days before sunset |

## Security

### Version Enforcement

- Minimum version requirements per endpoint
- Strict version validation
- Security patches for supported versions only

### Threat Mitigation

- Version confusion attack prevention
- Input validation on all endpoints
- Rate limiting (planned)
- Authentication/Authorization (planned)

## Contributing

1. Fork the repo and create a branch from `main`.
2. Install deps, run tests and build: `npm install && npm test && npm run build`.
3. Ensure 95%+ test coverage for new code.
4. Follow existing code structure and naming conventions.
5. Add NatSpec-style comments for public functions.
6. Update documentation for API changes.
7. Open a pull request with clear description.

### Commit Message Format

```
feat: implement versioned api foundation with tests and docs
fix: correct deprecation header format
docs: update API versioning guide
test: add edge cases for version extraction
```

## CI/CD

GitHub Actions runs on push and pull requests to `main`:

- Install dependencies
- Run linter
- Run tests with coverage
- Build the project
- Verify 95%+ coverage threshold

Keep the build passing before merging.

## Documentation

- [API Versioning Strategy](docs/backend/API_VERSIONING.md)
- [Migration Guide](docs/backend/API_VERSIONING.md#migration-guide)
- [Security Considerations](docs/backend/API_VERSIONING.md#security-considerations)

## License

MIT
