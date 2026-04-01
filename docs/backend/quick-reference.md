# Deployment Quick Reference

## Quick Commands

### Local Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Build project
npm run build

# Start development server
npm run dev

# Start production server
npm start
```

### Deployment

```bash
# Deploy to development
git push origin develop

# Deploy to staging
git push origin staging

# Deploy to production
git push origin main
```

### Validation

```bash
# Validate configuration
NODE_ENV=production npm run build
node -e "const {loadEnvironmentConfig}=require('./dist/config/environment');console.log(loadEnvironmentConfig())"

# Check test coverage
npm test -- --coverage --coverageReporters=text-summary
```

## Environment Variables

### Required

- `NODE_ENV` - Environment name (development, staging, production)

### Optional

- `PORT` - Server port (default: 3001)
- `API_BASE_URL` - API base URL
- `DEBUG` - Enable debug logging (true/false)
- `DATABASE_URL` - Database connection string
- `CORS_ORIGINS` - Comma-separated allowed origins
- `MAX_REQUEST_SIZE` - Max request body size (default: 10mb)

## Promotion Paths

```
Development → Staging → Production
```

### Valid Promotions

- ✅ Development → Staging
- ✅ Staging → Production
- ❌ Development → Production (not allowed)
- ❌ Production → Any (cannot promote from production)

## Rollback

```typescript
// Rollback staging
await rollbackDeployment({
  environment: 'staging',
  targetVersion: 'v1.0.0',
  reason: 'Bug found',
  initiatedBy: 'user@example.com'
});

// Rollback production
await rollbackDeployment({
  environment: 'production',
  targetVersion: 'v1.0.0',
  reason: 'Critical issue',
  initiatedBy: 'user@example.com'
});
```

## Validation Rules

### All Environments

- Port: 1-65535
- API URL: Valid URL format

### Production Only

- Stellar network: Must be mainnet
- CORS: No wildcards or localhost
- Debug: Should be disabled

## GitHub Actions

### Workflow Stages

1. Determine Environment
2. Build and Test
3. Security Scan
4. Validate Deployment
5. Deploy
6. Health Check

### Manual Trigger

1. Go to Actions tab
2. Select "Deployment Pipeline"
3. Click "Run workflow"
4. Select environment and version
5. Click "Run workflow" button

## Test Coverage

- Minimum recommended: 95%
- Current coverage: Check with `npm test -- --coverage`

## Security Checks

```bash
# Check for vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix

# Force fix (may have breaking changes)
npm audit fix --force
```

## Common Issues

### Tests Failing

```bash
# Check test output
npm test

# Run specific test file
npm test -- src/config/environment.test.ts
```

### Build Failing

```bash
# Check TypeScript errors
npm run build

# Clean and rebuild
rm -rf dist node_modules
npm install
npm run build
```

### Deployment Failing

1. Check GitHub Actions logs
2. Verify environment variables
3. Check validation errors
4. Review security scan results

## File Structure

```
src/
├── config/
│   ├── environment.ts          # Environment configuration
│   └── environment.test.ts     # Configuration tests
├── deployment/
│   ├── validator.ts            # Deployment validation
│   ├── validator.test.ts       # Validator tests
│   ├── promoter.ts             # Environment promotion
│   ├── promoter.test.ts        # Promoter tests
│   └── integration.test.ts     # Integration tests
└── index.ts                    # Main application

.github/
└── workflows/
    ├── ci.yml                  # CI workflow
    └── deploy.yml              # Deployment workflow

docs/backend/
├── deployment-guide.md         # Full deployment guide
├── security.md                 # Security documentation
├── environment-examples.md     # Configuration examples
└── quick-reference.md          # This file
```

## Key Contacts

- DevOps Team: [Configure contact]
- Security Team: [Configure contact]
- On-Call: [Configure contact]

## Links

- [Full Deployment Guide](./deployment-guide.md)
- [Security Documentation](./security.md)
- [Environment Examples](./environment-examples.md)
- [GitHub Actions](https://github.com/Talenttrust/Talenttrust-Backend/actions)
