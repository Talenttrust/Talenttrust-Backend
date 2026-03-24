# Quick Start Guide - Versioned API

## Installation

```bash
npm install
```

## Running the Server

```bash
# Development mode (hot reload)
npm run dev

# Production mode
npm run build
npm start
```

Server starts at: `http://localhost:3001`

## Testing

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Watch mode for development
npm run test:watch
```

## API Examples

### Health Check

```bash
curl http://localhost:3001/health
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

### Version Detection Methods

#### 1. URL Path (Recommended)

```bash
# v1 (deprecated)
curl http://localhost:3001/api/v1/contracts

# v2 (current)
curl http://localhost:3001/api/v2/contracts
```

#### 2. Accept Header

```bash
curl -H "Accept: application/vnd.talenttrust.v2+json" \
  http://localhost:3001/api/contracts
```

#### 3. Query Parameter

```bash
curl http://localhost:3001/api/contracts?version=v2
```

### v2 Features

```bash
# Pagination
curl http://localhost:3001/api/v2/contracts?limit=20

# Filtering
curl http://localhost:3001/api/v2/contracts?status=active

# Combined
curl http://localhost:3001/api/v2/contracts?limit=20&status=active

# Get specific contract
curl http://localhost:3001/api/v2/contracts/contract-123
```

## Deprecation Headers

When accessing v1 endpoints, you'll see:

```http
Deprecation: true
Sunset: Wed, 31 Dec 2024 23:59:59 GMT
Link: </api/v2/contracts>; rel="successor-version"
X-API-Deprecation-Warning: This endpoint is deprecated...
```

## Environment Variables

Create a `.env` file (optional):

```bash
PORT=3001
NODE_ENV=development
API_VERSION=v1
DEPRECATION_WARNING_DAYS=90
```

## Project Structure

```
src/
├── app.ts                  # Express app
├── index.ts                # Server startup
├── config/                 # Configuration
├── routes/                 # API routes
│   ├── v1/                # v1 endpoints
│   └── v2/                # v2 endpoints
└── versioning/            # Versioning logic
```

## Next Steps

1. Read [API_VERSIONING.md](./API_VERSIONING.md) for detailed versioning strategy
2. Review [SECURITY.md](./SECURITY.md) for security considerations
3. Check [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for technical details

## Common Tasks

### Adding a New Endpoint

1. Create route file in `src/routes/v2/`
2. Register route in `src/app.ts`
3. Add tests in `src/routes/v2/*.test.ts`
4. Update documentation

### Deprecating an Endpoint

```typescript
import { registerDeprecation } from './versioning';

registerDeprecation('GET', '/api/v1/old-endpoint', {
  deprecatedIn: 'v1',
  deprecatedAt: new Date('2024-01-01'),
  sunsetDate: new Date('2024-12-31'),
  replacement: '/api/v2/new-endpoint',
  notes: 'Migration notes here',
});
```

### Enforcing Minimum Version

```typescript
import { requireMinVersion } from './versioning';

app.use('/api/v2/admin', requireMinVersion('v2'));
```

## Troubleshooting

### Tests Failing

```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
npm test
```

### Build Errors

```bash
# Check TypeScript version
npx tsc --version

# Rebuild
npm run build
```

### Port Already in Use

```bash
# Change port in .env or:
PORT=3002 npm run dev
```

## Support

- Documentation: `docs/backend/`
- Issues: Create GitHub issue
- Security: See [SECURITY.md](./SECURITY.md)
