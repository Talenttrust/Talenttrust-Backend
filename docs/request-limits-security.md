# Request Limits Security Implementation

## Overview

This document outlines the security implementation of strict request body size limits and content-type enforcement middleware for the Talenttrust Backend.

## Security Features

### 1. Request Body Size Limits

**Purpose**: Prevent large-payload DoS attacks by limiting the maximum size of incoming request bodies.

**Implementation**:
- Default limit: 1MB (1,048,576 bytes)
- Configurable via `MAX_REQUEST_BODY_SIZE` environment variable
- Validates `Content-Length` header before processing
- Returns HTTP 413 (Payload Too Large) for oversized requests

**Security Benefits**:
- Prevents memory exhaustion attacks
- Reduces attack surface for large payload vulnerabilities
- Protects against bandwidth exhaustion attacks

### 2. Content-Type Enforcement

**Purpose**: Ensure requests use appropriate content types, preventing ambiguous parsing and injection attacks.

**Implementation**:
- Default: JSON-only (`application/json`)
- Configurable via `ALLOWED_CONTENT_TYPES` environment variable
- Validates media type (ignores charset parameters)
- Excludes GET/HEAD requests from validation
- Returns HTTP 415 (Unsupported Media Type) for invalid types

**Security Benefits**:
- Prevents content-type confusion attacks
- Reduces risk of parsing vulnerabilities
- Enforces strict API contract compliance

### 3. Path Exclusions

**Purpose**: Allow specific endpoints to bypass validation for legitimate use cases.

**Implementation**:
- Default exclusions: `/health`, `/metrics`
- Configurable via `REQUEST_LIMITS_EXCLUDE_PATHS` environment variable
- Supports path prefix matching

**Security Considerations**:
- Excluded paths should be carefully reviewed
- Monitor excluded endpoints for abuse
- Consider rate limiting for excluded paths

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_REQUEST_BODY_SIZE` | `1048576` | Maximum request body size in bytes |
| `ENFORCE_JSON_CONTENT_TYPE` | `true` | Enable/disable content-type enforcement |
| `ALLOWED_CONTENT_TYPES` | `application/json` | Comma-separated allowed content types |
| `REQUEST_LIMITS_EXCLUDE_PATHS` | `/health,/metrics` | Comma-separated paths to exclude |

### Security Recommendations

1. **Production Settings**:
   ```bash
   MAX_REQUEST_BODY_SIZE=1048576  # 1MB limit
   ENFORCE_JSON_CONTENT_TYPE=true
   ALLOWED_CONTENT_TYPES=application/json
   REQUEST_LIMITS_EXCLUDE_PATHS=/health,/metrics
   ```

2. **High-Security Environments**:
   ```bash
   MAX_REQUEST_BODY_SIZE=524288   # 512KB limit
   ENFORCE_JSON_CONTENT_TYPE=true
   ALLOWED_CONTENT_TYPES=application/json
   REQUEST_LIMITS_EXCLUDE_PATHS=/health
   ```

## Error Handling

### Standardized Error Responses

All validation errors return consistent error payloads:

```json
{
  "error": {
    "code": "payload_too_large" | "unsupported_media_type",
    "message": "Human-readable error description",
    "requestId": "unique-request-identifier"
  }
}
```

### Error Codes

- `payload_too_large`: HTTP 413 - Request exceeds size limit
- `unsupported_media_type`: HTTP 415 - Invalid content-type

## Testing

### Test Coverage

- Unit tests for all middleware functions
- Integration tests with full application
- Environment configuration tests
- Error response format validation
- Path exclusion validation

### Security Test Scenarios

1. **Size Limit Tests**:
   - Normal-sized requests (should pass)
   - Oversized requests (should fail)
   - Missing Content-Length header (should pass if body is small)

2. **Content-Type Tests**:
   - Valid JSON content-type (should pass)
   - Invalid content-types (should fail)
   - Missing content-type (should fail)
   - Content-type with charset (should pass)

3. **Exclusion Tests**:
   - Excluded paths with invalid data (should pass)
   - Non-excluded paths with invalid data (should fail)

## Performance Considerations

### Minimal Overhead

- Header-only validation when possible
- Early rejection of invalid requests
- Efficient string comparison for content-types
- Path prefix matching for exclusions

### Memory Usage

- No buffering of request bodies
- Validation occurs before body parsing
- Configurable limits prevent memory exhaustion

## Monitoring and Alerting

### Recommended Metrics

1. **Request Validation Metrics**:
   - Count of rejected requests by error type
   - Average request size
   - Request size distribution

2. **Security Metrics**:
   - Rate of payload_too_large errors
   - Rate of unsupported_media_type errors
   - Geographic analysis of rejected requests

### Alerting Rules

- High rate of 413/415 errors (potential attack)
- Sudden increase in average request size
- Repeated violations from specific IP ranges

## Deployment Notes

### Gradual Rollout

1. Start with permissive limits in staging
2. Monitor error rates and adjust thresholds
3. Deploy to production with monitoring
4. Tighten limits based on observed patterns

### Rollback Plan

- Environment variables can be quickly adjusted
- Middleware can be disabled via configuration
- Previous behavior can be restored by setting high limits

## Compliance

This implementation helps with:
- **OWASP Top 10**: Addresses A05 (Security Misconfiguration) and A04 (Insecure Design)
- **PCI DSS**: Limits data exposure through size restrictions
- **GDPR**: Prevents bulk data extraction attacks

## Future Enhancements

1. **Dynamic Limits**: Per-endpoint size limits
2. **Rate Limiting Integration**: Combined size and rate validation
3. **Machine Learning**: Adaptive limit adjustment based on traffic patterns
4. **Advanced Content-Type**: Schema validation integration
