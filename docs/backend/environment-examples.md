# Environment Configuration Examples

## Overview

This document provides example configurations for each environment in the TalentTrust Backend deployment pipeline.

## Development Environment

### Configuration

```bash
# .env.development
NODE_ENV=development
PORT=3001
API_BASE_URL=http://localhost:3001
DEBUG=true
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
MAX_REQUEST_SIZE=10mb
```

### Characteristics

- Uses Stellar testnet
- Allows localhost CORS origins
- Debug mode enabled
- Relaxed security for local development
- No approval required for deployment

### Usage

```bash
# Local development
npm run dev

# Run tests
npm test

# Build
npm run build
```

## Staging Environment

### Configuration

```bash
# .env.staging
NODE_ENV=staging
PORT=3002
API_BASE_URL=https://staging-api.talenttrust.example.com
DEBUG=false
CORS_ORIGINS=https://staging.talenttrust.example.com
MAX_REQUEST_SIZE=10mb
DATABASE_URL=postgresql://user:pass@staging-db.example.com:5432/talenttrust
```

### Characteristics

- Uses Stellar testnet (recommended)
- Production-like configuration
- No localhost CORS origins
- Debug mode disabled
- Pre-production testing environment
- Requires promotion from development

### GitHub Secrets

```yaml
# Configure in GitHub: Settings → Secrets → Actions
DATABASE_URL: postgresql://user:pass@staging-db.example.com:5432/talenttrust
STELLAR_SECRET_KEY: S[STAGING_SECRET_KEY]
API_KEY: [STAGING_API_KEY]
```

### Deployment

```bash
# Automatic deployment
git push origin staging

# Manual deployment via GitHub Actions
# Actions → Deployment Pipeline → Run workflow
# Select: staging
```

## Production Environment

### Configuration

```bash
# .env.production
NODE_ENV=production
PORT=3000
API_BASE_URL=https://api.talenttrust.example.com
DEBUG=false
CORS_ORIGINS=https://app.talenttrust.example.com,https://www.talenttrust.example.com
MAX_REQUEST_SIZE=10mb
DATABASE_URL=postgresql://user:pass@prod-db.example.com:5432/talenttrust
```

### Characteristics

- Uses Stellar mainnet (required)
- Strict security configuration
- No localhost or wildcard CORS
- Debug mode disabled
- Requires promotion from staging
- Requires manual approval
- Full monitoring and alerting

### GitHub Secrets

```yaml
# Configure in GitHub: Settings → Secrets → Actions
DATABASE_URL: postgresql://user:pass@prod-db.example.com:5432/talenttrust
STELLAR_SECRET_KEY: S[PRODUCTION_SECRET_KEY]
API_KEY: [PRODUCTION_API_KEY]
ENCRYPTION_KEY: [PRODUCTION_ENCRYPTION_KEY]
```

### Deployment

```bash
# Automatic deployment (requires approval)
git push origin main

# Manual deployment via GitHub Actions
# Actions → Deployment Pipeline → Run workflow
# Select: production
# Requires: Manual approval from authorized reviewers
```

## Environment Comparison

| Feature | Development | Staging | Production |
|---------|------------|---------|------------|
| Stellar Network | Testnet | Testnet | Mainnet |
| Debug Mode | Enabled | Disabled | Disabled |
| CORS Origins | Localhost OK | No localhost | No localhost |
| Approval Required | No | No | Yes |
| Monitoring | Optional | Recommended | Required |
| Rollback Support | No | Yes | Yes |
| Auto-deploy Branch | `develop` | `staging` | `main` |

## Configuration Validation

### Development

```typescript
// Valid development config
{
  environment: 'development',
  port: 3001,
  apiBaseUrl: 'http://localhost:3001',
  debug: true,
  stellarNetwork: 'testnet',
  corsOrigins: ['http://localhost:3000']
}
```

### Staging

```typescript
// Valid staging config
{
  environment: 'staging',
  port: 3002,
  apiBaseUrl: 'https://staging-api.example.com',
  debug: false,
  stellarNetwork: 'testnet',
  corsOrigins: ['https://staging.example.com']
}
```

### Production

```typescript
// Valid production config
{
  environment: 'production',
  port: 3000,
  apiBaseUrl: 'https://api.example.com',
  debug: false,
  stellarNetwork: 'mainnet',
  corsOrigins: ['https://app.example.com']
}

// Invalid production config - will fail validation
{
  environment: 'production',
  stellarNetwork: 'testnet',  // ❌ Must be mainnet
  corsOrigins: ['*']  // ❌ No wildcards
}
```

## GitHub Environment Configuration

### Setting Up Environments

1. Go to repository Settings → Environments
2. Create three environments: `development`, `staging`, `production`

### Development Environment

```yaml
Name: development
Protection rules: None
Environment secrets: (optional)
```

### Staging Environment

```yaml
Name: staging
Protection rules:
  - Wait timer: 0 minutes
  - Required reviewers: 0
Environment secrets:
  - DATABASE_URL
  - STELLAR_SECRET_KEY
  - API_KEY
```

### Production Environment

```yaml
Name: production
Protection rules:
  - Wait timer: 5 minutes
  - Required reviewers: 2
  - Allowed branches: main
Environment secrets:
  - DATABASE_URL
  - STELLAR_SECRET_KEY
  - API_KEY
  - ENCRYPTION_KEY
```

## Testing Configurations

### Local Testing

```bash
# Test development config
NODE_ENV=development npm test

# Test staging config
NODE_ENV=staging npm test

# Test production config
NODE_ENV=production npm test
```

### Validation Script

```bash
# Validate configuration
node -e "
const { loadEnvironmentConfig } = require('./dist/config/environment');
const { validateDeploymentConfig } = require('./dist/deployment/validator');

const config = loadEnvironmentConfig();
const validation = validateDeploymentConfig(config);

console.log('Environment:', config.environment);
console.log('Valid:', validation.valid);
console.log('Errors:', validation.errors);
console.log('Warnings:', validation.warnings);
"
```

## Common Configuration Issues

### Issue: Invalid Port

```bash
# ❌ Invalid
PORT=0
PORT=70000

# ✅ Valid
PORT=3000
PORT=8080
```

### Issue: Invalid URL

```bash
# ❌ Invalid
API_BASE_URL=not-a-url
API_BASE_URL=

# ✅ Valid
API_BASE_URL=http://localhost:3001
API_BASE_URL=https://api.example.com
```

### Issue: Production CORS

```bash
# ❌ Invalid for production
CORS_ORIGINS=*
CORS_ORIGINS=http://localhost:3000

# ✅ Valid for production
CORS_ORIGINS=https://app.example.com
CORS_ORIGINS=https://app.example.com,https://www.example.com
```

### Issue: Production Network

```bash
# ❌ Invalid for production
NODE_ENV=production
# stellarNetwork will be 'testnet' by default

# ✅ Valid for production
NODE_ENV=production
# stellarNetwork will be 'mainnet' automatically
```

## Migration Guide

### From Development to Staging

1. Update environment variables
2. Change CORS origins to staging domain
3. Disable debug mode
4. Configure staging secrets in GitHub
5. Push to `staging` branch

### From Staging to Production

1. Update environment variables
2. Change CORS origins to production domain
3. Verify Stellar mainnet configuration
4. Configure production secrets in GitHub
5. Set up environment protection rules
6. Push to `main` branch
7. Approve deployment

## Best Practices

1. **Never commit `.env` files** - Use `.env.example` instead
2. **Use GitHub Secrets** for sensitive data
3. **Validate before deploying** - Run validation script
4. **Test in staging first** - Always test before production
5. **Document changes** - Update this guide when adding new variables
6. **Rotate secrets regularly** - Update credentials periodically
7. **Monitor configurations** - Alert on configuration changes

## References

- [Environment Configuration Module](../../src/config/environment.ts)
- [Deployment Validator](../../src/deployment/validator.ts)
- [Deployment Guide](./deployment-guide.md)
- [Security Documentation](./security.md)
