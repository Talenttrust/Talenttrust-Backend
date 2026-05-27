# Deployment Automation Pipeline Guide

## Overview

This guide describes the reproducible deployment workflow with environment promotion for the TalentTrust Backend. The system provides automated, secure, and tested deployments across development, staging, and production environments.

## Architecture

### Environment Promotion Flow

```
Development → Staging → Production
```

- **Development**: Continuous deployment from `develop` branch
- **Staging**: Deployment from `staging` branch for pre-production testing
- **Production**: Deployment from `main` branch with additional safeguards

### Key Components

1. **Environment Configuration** (`src/config/environment.ts`)
   - Manages environment-specific settings
   - Validates configuration for each environment
   - Supports multiple deployment targets

2. **Deployment Validator** (`src/deployment/validator.ts`)
   - Pre-deployment validation checks
   - Configuration validation
   - Health check capabilities

3. **Environment Promoter** (`src/deployment/promoter.ts`)
   - Manages promotion between environments
   - Enforces promotion paths
   - Provides rollback capabilities

4. **GitHub Actions Workflow** (`.github/workflows/deploy.yml`)
   - Automated CI/CD pipeline
   - Multi-stage deployment process
   - Security scanning and validation

## Deployment Workflow

### Automatic Deployments

Deployments are triggered automatically on push to specific branches:

- Push to `develop` → Deploy to Development
- Push to `staging` → Deploy to Staging
- Push to `main` → Deploy to Production

### Manual Deployments

Manual deployments can be triggered via GitHub Actions:

1. Go to Actions tab in GitHub
2. Select "Deployment Pipeline" workflow
3. Click "Run workflow"
4. Select target environment and version
5. Click "Run workflow" button

### Deployment Stages

1. **Determine Environment**
   - Identifies target environment based on branch or manual input
   - Sets deployment flags

2. **Build and Test**
   - Installs dependencies
   - Runs linter
   - Executes test suite with coverage check (95% minimum recommended)
   - Builds application
   - Uploads build artifacts

3. **Security Scan**
   - Runs npm audit
   - Checks for known vulnerabilities
   - Reports security issues

4. **Validate Deployment**
   - Validates environment configuration
   - Checks deployment readiness
   - Verifies environment-specific requirements

5. **Deploy**
   - Downloads build artifacts
   - Deploys to target environment
   - Creates deployment record

6. **Health Check**
   - Waits for deployment stabilization
   - Performs health checks
   - Notifies deployment status

## Environment Configuration

### Required Environment Variables

All environments require:

- `NODE_ENV`: Environment name (development, staging, production)

### Optional Environment Variables

- `PORT`: Server port (default: 3001)
- `API_BASE_URL`: API base URL
- `DEBUG`: Enable debug logging (true/false)
- `DATABASE_URL`: Database connection string
- `CORS_ORIGINS`: Comma-separated list of allowed origins
- `MAX_REQUEST_SIZE`: Maximum request body size (default: 10mb)

### Environment-Specific Requirements

#### Development
- No special requirements
- Uses Stellar testnet
- Allows localhost CORS origins

#### Staging
- Should use Stellar testnet (mainnet allowed with warning)
- Should not use localhost CORS origins
- Debug mode allowed

#### Production
- Must use Stellar mainnet
- Must not use localhost or wildcard CORS origins
- Debug mode not recommended
- Requires production-grade configuration

## Promotion Process

### Valid Promotion Paths

- Development → Staging ✅
- Staging → Production ✅
- Development → Production ❌ (not allowed)
- Production → Any ❌ (cannot promote from production)

### Promoting a Deployment

```typescript
import { promoteDeployment } from './src/deployment/promoter';

const result = await promoteDeployment({
  from: 'staging',
  to: 'production',
  version: 'v1.2.0',
  initiatedBy: 'user@example.com',
  timestamp: new Date(),
});

if (result.success) {
  console.log('Promotion successful:', result.promotionId);
} else {
  console.error('Promotion failed:', result.error);
}
```

## Rollback Process

### When to Rollback

- Critical bugs discovered in production
- Performance degradation
- Security vulnerabilities
- Failed deployment

### Performing a Rollback

```typescript
import { rollbackDeployment } from './src/deployment/promoter';

const result = await rollbackDeployment({
  environment: 'production',
  targetVersion: 'v1.1.0',
  reason: 'Critical bug in payment processing',
  initiatedBy: 'user@example.com',
});

if (result.success) {
  console.log('Rollback successful:', result.rollbackId);
} else {
  console.error('Rollback failed:', result.error);
}
```

### Rollback Limitations

- Development environment does not support rollback
- Target version must exist and be valid
- Rollback does not automatically revert database migrations

## Security Considerations

### Pre-Deployment Checks

1. **Dependency Scanning**: npm audit checks for known vulnerabilities
2. **Configuration Validation**: Ensures secure configuration for each environment
3. **Test Coverage**: Minimum 95% coverage recommended
4. **Linting**: Code quality checks

### Production Safeguards

- Requires approval via GitHub environment protection rules
- Validates Stellar mainnet configuration
- Prevents wildcard or localhost CORS origins
- Warns if debug mode is enabled

### Secrets Management

Store sensitive configuration in GitHub Secrets:

1. Go to repository Settings → Secrets and variables → Actions
2. Add environment-specific secrets
3. Reference in workflow: `${{ secrets.SECRET_NAME }}`

## Monitoring and Logging

### Deployment Logs

All deployments create records with:
- Timestamp
- Environment
- Commit SHA
- Initiating user
- Deployment status

### Health Checks

Post-deployment health checks verify:
- Service availability
- API responsiveness
- Configuration correctness

## Troubleshooting

### Common Issues

#### Deployment Fails at Validation Stage

**Cause**: Invalid environment configuration

**Solution**: Check environment variables and configuration requirements

```bash
NODE_ENV=production npm run build
node -e "const { loadEnvironmentConfig } = require('./dist/config/environment'); console.log(loadEnvironmentConfig());"
```

#### Test Coverage Below 95%

**Cause**: Insufficient test coverage

**Solution**: Add tests for uncovered code paths

```bash
npm test -- --coverage
```

#### Security Vulnerabilities Found

**Cause**: Outdated dependencies with known vulnerabilities

**Solution**: Update dependencies

```bash
npm audit fix
npm audit fix --force  # For breaking changes
```

#### Promotion Path Invalid

**Cause**: Attempting invalid promotion (e.g., dev → prod)

**Solution**: Follow valid promotion paths (dev → staging → prod)

### Getting Help

- Check GitHub Actions logs for detailed error messages
- Review deployment validation output
- Consult security scan results
- Contact DevOps team for infrastructure issues

## Best Practices

1. **Always test in staging before production**
   - Deploy to staging first
   - Run integration tests
   - Verify functionality
   - Then promote to production

2. **Use semantic versioning**
   - Tag releases with version numbers
   - Follow semver conventions (MAJOR.MINOR.PATCH)
   - Document breaking changes

3. **Monitor deployments**
   - Watch health check results
   - Monitor application logs
   - Set up alerts for failures

4. **Keep dependencies updated**
   - Regularly run `npm audit`
   - Update dependencies promptly
   - Test after updates

5. **Document configuration changes**
   - Update environment variable documentation
   - Communicate changes to team
   - Update deployment guide as needed

## Maintenance

### Regular Tasks

- Review and update dependencies monthly
- Audit security vulnerabilities weekly
- Review deployment logs regularly
- Update documentation as system evolves

### Updating the Pipeline

1. Create feature branch
2. Modify workflow files
3. Test in development environment
4. Submit pull request
5. Review and merge

## References

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [Semantic Versioning](https://semver.org/)
- [Stellar Network Documentation](https://developers.stellar.org/)
