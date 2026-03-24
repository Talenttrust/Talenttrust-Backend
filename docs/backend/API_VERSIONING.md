# API Versioning Strategy

## Overview

TalentTrust Backend implements a comprehensive API versioning strategy to ensure backward compatibility, smooth migrations, and clear deprecation policies.

## Versioning Approach

### URL-Based Versioning (Primary)

The API uses URL path-based versioning as the primary method:

```
/api/v1/contracts
/api/v2/contracts
```

### Alternative Version Detection

The system also supports version detection through:

1. **Accept Header** (Secondary)
   ```
   Accept: application/vnd.talenttrust.v2+json
   ```

2. **Query Parameter** (Tertiary)
   ```
   /api/contracts?version=v2
   ```

### Priority Order

1. URL path (`/api/v1/...`)
2. Accept header (`application/vnd.talenttrust.v2+json`)
3. Query parameter (`?version=v2`)
4. Default to `v1`

## Supported Versions

| Version | Status | Release Date | Sunset Date |
|---------|--------|--------------|-------------|
| v1      | Deprecated | 2024-01-01 | 2024-12-31 |
| v2      | Active | 2024-06-01 | TBD |

## Deprecation Policy

### Deprecation Timeline

1. **Announcement** (T+0): Deprecation announced with 6-month notice
2. **Warning Period** (T+0 to T+6mo): Deprecation headers added to responses
3. **Sunset** (T+6mo): Endpoint removed from service

### Deprecation Headers

When accessing deprecated endpoints, the following headers are included:

```http
Deprecation: true
Sunset: Wed, 31 Dec 2024 23:59:59 GMT
Link: </api/v2/contracts>; rel="successor-version"
X-API-Deprecation-Warning: This endpoint is deprecated as of 2024-01-01 and will be removed on 2024-12-31. Please migrate to /api/v2/contracts. v2 includes enhanced filtering and pagination.
```

### Header Standards

- **Deprecation**: Boolean indicator (draft standard)
- **Sunset**: RFC 8594 compliant date
- **Link**: RFC 8288 compliant successor link
- **X-API-Deprecation-Warning**: Human-readable migration guidance

## Version Differences

### v1 vs v2 Comparison

#### GET /api/v1/contracts vs GET /api/v2/contracts

**v1 Response:**
```json
{
  "version": "v1",
  "contracts": [],
  "message": "Contract listing endpoint"
}
```

**v2 Response:**
```json
{
  "version": "v2",
  "contracts": [],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 0
  },
  "filters": {}
}
```

**Key Improvements in v2:**
- Pagination support (`limit`, `offset`)
- Advanced filtering capabilities
- Consistent response structure
- Enhanced metadata

## Implementation Guide

### Registering Deprecated Endpoints

```typescript
import { registerDeprecation } from './versioning';

registerDeprecation('GET', '/api/v1/contracts', {
  deprecatedIn: 'v1',
  deprecatedAt: new Date('2024-01-01'),
  sunsetDate: new Date('2024-12-31'),
  replacement: '/api/v2/contracts',
  notes: 'v2 includes enhanced filtering and pagination',
});
```

### Creating Versioned Routes

```typescript
import express from 'express';
import contractsV1 from './routes/v1/contracts';
import contractsV2 from './routes/v2/contracts';

const app = express();

app.use('/api/v1/contracts', contractsV1);
app.use('/api/v2/contracts', contractsV2);
```

### Enforcing Minimum Version

```typescript
import { requireMinVersion } from './versioning';

// Require v2 or higher
app.use('/api/v2/advanced', requireMinVersion('v2'));
```

## Migration Guide

### For API Consumers

1. **Monitor Deprecation Headers**: Check response headers for deprecation warnings
2. **Update Base URLs**: Change `/api/v1/` to `/api/v2/`
3. **Adapt to New Response Structure**: Update parsing logic for pagination
4. **Test Thoroughly**: Validate all integrations with v2 endpoints
5. **Complete Before Sunset**: Migrate before the sunset date

### Breaking Changes Checklist

When introducing a new version:

- [ ] Document all breaking changes
- [ ] Provide migration examples
- [ ] Update API documentation
- [ ] Announce deprecation timeline
- [ ] Add deprecation headers
- [ ] Monitor usage metrics
- [ ] Communicate with stakeholders

## Security Considerations

### Version-Specific Security

- Each version maintains independent security policies
- Deprecated versions receive critical security patches only
- After sunset, no security updates are provided

### Threat Scenarios

1. **Version Confusion Attacks**: Mitigated by strict version validation
2. **Deprecated Endpoint Exploitation**: Monitored and patched during warning period
3. **Version Downgrade Attacks**: Prevented by minimum version enforcement

## Testing Strategy

### Coverage Requirements

- Minimum 95% test coverage for all versioning modules
- Integration tests for each versioned endpoint
- Deprecation header validation tests
- Version detection tests across all methods

### Test Categories

1. **Unit Tests**: Individual module functionality
2. **Integration Tests**: End-to-end API behavior
3. **Security Tests**: Version enforcement and validation
4. **Regression Tests**: Backward compatibility verification

## Monitoring and Metrics

### Key Metrics

- Version usage distribution
- Deprecated endpoint access frequency
- Migration completion rate
- Error rates by version

### Alerting

- Spike in deprecated endpoint usage
- Sunset date approaching with high v1 usage
- Version detection failures

## References

- [RFC 8594: Sunset HTTP Header](https://tools.ietf.org/html/rfc8594)
- [RFC 8288: Web Linking](https://tools.ietf.org/html/rfc8288)
- [API Versioning Best Practices](https://restfulapi.net/versioning/)

## Support

For questions or issues related to API versioning:
- Create an issue in the repository
- Contact the backend team
- Review the migration guide above
