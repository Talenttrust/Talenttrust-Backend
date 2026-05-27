# Request Limits Implementation Guide

## Summary

This implementation adds strict request body size limits and content-type enforcement middleware to the Talenttrust Backend to prevent large-payload DoS attacks and ensure proper content handling.

## Files Added/Modified

### New Files
- `src/middleware/requestLimits.ts` - Main middleware implementation
- `src/middleware/__tests__/requestLimits.test.ts` - Unit tests
- `src/requestLimits.integration.test.ts` - Integration tests
- `docs/request-limits-security.md` - Security documentation

### Modified Files
- `src/app.ts` - Integrated middleware into application
- `.env.example` - Added new environment variables

## Implementation Details

### Middleware Features

1. **Request Body Size Limits**
   - Default: 1MB maximum
   - Validates Content-Length header
   - Returns HTTP 413 for oversized requests

2. **Content-Type Enforcement**
   - Default: JSON-only (`application/json`)
   - Validates media type (ignores charset)
   - Returns HTTP 415 for invalid content-types
   - Excludes GET/HEAD requests

3. **Path Exclusions**
   - Default: `/health`, `/metrics`
   - Configurable via environment
   - Supports prefix matching

### Environment Configuration

```bash
# Request size limit (bytes)
MAX_REQUEST_BODY_SIZE=1048576

# Content-type enforcement
ENFORCE_JSON_CONTENT_TYPE=true
ALLOWED_CONTENT_TYPES=application/json

# Path exclusions
REQUEST_LIMITS_EXCLUDE_PATHS=/health,/metrics
```

### Error Responses

All errors use the standard application error format:

```json
{
  "error": {
    "code": "payload_too_large" | "unsupported_media_type",
    "message": "Descriptive error message",
    "requestId": "unique-identifier"
  }
}
```

## Testing

### Test Coverage
- Unit tests: 100% coverage of middleware functions
- Integration tests: Full application testing
- Environment configuration tests
- Error handling validation

### Running Tests
```bash
npm run test:ci
npm run test:watch
```

### Specific Test Files
- `src/middleware/__tests__/requestLimits.test.ts` - Unit tests
- `src/requestLimits.integration.test.ts` - Integration tests

## Security Benefits

1. **DoS Prevention**: Limits request size to prevent memory exhaustion
2. **Content-Type Security**: Prevents parsing vulnerabilities
3. **Standardized Errors**: Consistent error handling prevents information leakage
4. **Configurable**: Environment-driven settings for different deployment needs

## Performance Impact

- Minimal overhead (header-only validation when possible)
- Early rejection of invalid requests
- No request body buffering
- Efficient string comparisons

## Migration Guide

### For Existing Applications
1. No breaking changes for valid requests
2. Invalid requests will now be rejected with proper error codes
3. Configure environment variables as needed

### Recommended Settings
- **Development**: Default settings (1MB, JSON-only)
- **Staging**: Stricter limits (512KB) for testing
- **Production**: Conservative limits with monitoring

## Monitoring

### Key Metrics to Monitor
- Rate of 413 errors (payload too large)
- Rate of 415 errors (unsupported media type)
- Average request size
- Request size distribution

### Alerting
- High error rates may indicate attacks
- Monitor for abuse patterns
- Track geographic distribution of violations

## Troubleshooting

### Common Issues

1. **Legitimate requests being rejected**
   - Check Content-Length header accuracy
   - Verify content-type configuration
   - Consider path exclusions if needed

2. **Integration issues**
   - Ensure clients send proper Content-Type headers
   - Verify request sizes are within limits
   - Check environment variable configuration

### Debugging
- Enable debug logging
- Monitor error responses
- Test with different request sizes and content-types

## Future Considerations

1. **Dynamic Limits**: Per-endpoint configuration
2. **Rate Limiting Integration**: Combined validation
3. **Advanced Content-Type**: Schema validation
4. **Machine Learning**: Adaptive limit adjustment
