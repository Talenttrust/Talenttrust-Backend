# Structured Logging with Pino

This document describes the TalentTrust Backend's structured logging implementation using Pino, including the JSON field schema, redaction rules, and correlation ID propagation.

## Overview

The backend uses [Pino](https://getpino.io/) as its structured logging library. Pino provides high-performance JSON logging with built-in redaction capabilities and child logger support for request correlation.

## Logger Configuration

The logger is configured in `src/logger.ts` with the following settings:

- **Format**: Newline-delimited JSON (NDJSON)
- **Levels**: `trace`, `debug`, `info`, `warn`, `error`, `fatal`
- **Default Level**: `info` in production, `debug` in development
- **Pretty Printing**: Enabled in development via `pino-pretty`
- **Redaction**: Automatic redaction of sensitive fields with `[REDACTED]`

## JSON Field Schema

Every log record contains the following base fields:

| Field | Type | Description |
|-------|------|-------------|
| `level` | string | Log level (trace, debug, info, warn, error, fatal) |
| `time` | number | Unix timestamp in milliseconds (Pino default) |
| `message` | string | Human-readable log message |
| `service` | string | Constant value: `"talenttrust-backend"` |
| `pid` | number | Process ID |
| `hostname` | string | Hostname (from `HOSTNAME` env var or `"unknown"`) |
| `requestId` | string (optional) | Per-request UUID for tracing |
| `correlationId` | string (optional) | Caller-supplied trace ID for distributed tracing |
| `err` | object (optional) | Error object with `type`, `message`, and `stack` (non-production) |

### Additional Context Fields

Any additional fields passed to the logger are merged into the log record. For example:

```json
{
  "level": "info",
  "time": 1714377600000,
  "message": "User logged in",
  "service": "talenttrust-backend",
  "pid": 12345,
  "hostname": "web-01",
  "userId": "user-123",
  "action": "login",
  "ip": "192.168.1.1"
}
```

## Redaction Rules

Sensitive data is automatically redacted using Pino's redaction feature. The following field patterns are redacted with `[REDACTED]`:

### Authentication & Authorization
- `password`, `passwd`, `pwd`
- `secret`, `secrets`
- `token`, `tokens`, `jwt`, `bearer`
- `authorization`, `auth`
- `apikey`, `api_key`, `apikey_secret`
- `access_token`, `refresh_token`
- `client_secret`, `client_id`

### Personal Identifiable Information (PII)
- `email`, `email_address`
- `ssn`, `social_security_number`
- `credit_card`, `cc_number`, `cvv`
- `bank_account`, `routing_number`
- `phone`, `phone_number`, `mobile`
- `address`, `street_address`

### Cryptographic
- `privatekey`, `private_key`, `privateKey`
- `publickey`, `public_key`, `publicKey`
- `mnemonic`, `seed`, `seed_phrase`
- `wallet`, `wallet_private_key`

### Session & Cookies
- `cookie`, `cookies`, `session`
- `session_id`, `session_token`

### Database
- `db_password`, `database_password`
- `connection_string`, `conn_string`

### Generic Sensitive Patterns
- `key`, `secret_key`, `passphrase`

### Redaction Behavior

Redaction applies to:
- Top-level fields: `{ password: "secret" }` → `{ password: "[REDACTED]" }`
- Nested fields: `{ user: { email: "test@example.com" } }` → `{ user: { email: "[REDACTED]" } }`
- Deeply nested fields: `{ data: { user: { password: "secret" } } }` → `{ data: { user: { password: "[REDACTED]" } } }`

### Example

```typescript
logger.info('User registration', {
  email: 'user@example.com',
  password: 'hunter2',
  name: 'John Doe'
});
```

**Output:**
```json
{
  "level": "info",
  "message": "User registration",
  "email": "[REDACTED]",
  "password": "[REDACTED]",
  "name": "John Doe"
}
```

## Request Correlation

### HTTP Request Correlation

HTTP requests are correlated using the `requestIdMiddleware` in `src/middleware/requestId.ts`:

1. **Request ID Generation**:
   - If `X-Request-Id` header is present and valid, it is reused
   - Otherwise, a new UUID v4 is generated
   - The ID is written back to the response as `X-Request-Id`

2. **Correlation ID Propagation**:
   - If `X-Correlation-Id` header is present and valid, it is forwarded
   - The ID is written back to the response as `X-Correlation-Id` when present

3. **Request-Scoped Logger**:
   - A child logger is attached to `res.locals.log` with the correlation context
   - All logs using this logger automatically include `requestId` and `correlationId`

### HTTP Access Logging

The `httpLoggerMiddleware` in `src/middleware/httpLogger.ts` emits structured access logs for every HTTP request/response pair:

```json
{
  "level": "info",
  "message": "http request",
  "method": "GET",
  "url": "/api/v1/contracts",
  "statusCode": 200,
  "durationMs": 45.234,
  "userAgent": "Mozilla/5.0...",
  "ip": "192.168.1.1",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "correlationId": "trace-abc-123"
}
```

### Job Correlation

Background jobs support correlation IDs through the queue system:

1. **Job Payload Structure**:
   - All job payloads include optional `correlationId` and `requestId` fields
   - See `src/queue/types.ts` for payload definitions

2. **Job Enqueue**:
   ```typescript
   await queueManager.addJob(JobType.EMAIL_NOTIFICATION, payload, {
     correlationId: req.headers['x-correlation-id'] as string,
     requestId: res.locals.requestId
   });
   ```

3. **Job Processing**:
   - The queue manager extracts correlation IDs from the job payload
   - A child logger is created with correlation context
   - All logs within job processing include `correlationId`, `requestId`, and `jobType`

## Usage Examples

### Basic Logging

```typescript
import { logger } from './logger';

logger.info('Server started');
logger.error('Database connection failed', { error: err.message });
logger.debug('Processing request', { userId: '123' });
```

### Request-Scoped Logging

```typescript
import { createRequestLogger } from './logger';

// In middleware or route handler
const reqLogger = createRequestLogger(requestId, correlationId);
reqLogger.info('Processing user request', { userId: '123' });
```

### Child Logger for Context

```typescript
import { logger } from './logger';

const userLogger = logger.child({ userId: '123', action: 'profile_update' });
userLogger.info('Profile updated');
userLogger.error('Update failed', { error: err.message });
```

### Error Logging

```typescript
import { logger } from './logger';

try {
  await someOperation();
} catch (err) {
  logger.error('Operation failed', { err });
}
```

## Testing

Redaction behavior is tested in `src/logger.test.ts`:

```typescript
describe('Logger – sensitive key redaction', () => {
  it('redacts "password" field', () => {
    const log = new Logger();
    log.info('sensitive', { password: 'secret' });
    expect(cap.logs[0]!['password']).toBe('[REDACTED]');
  });

  it('redacts nested sensitive fields', () => {
    const log = new Logger();
    log.info('nested', { user: { email: 'test@example.com' } });
    expect(cap.logs[0]!['user']['email']).toBe('[REDACTED]');
  });
});
```

Run the tests:

```bash
npm run test:ci -- --testPathPattern="logger"
```

## Security Considerations

1. **Never log sensitive data**: The redaction rules are a safety net, but avoid passing sensitive data to log calls entirely.

2. **Stack traces**: Error stack traces are only included in non-production environments to avoid leaking internal file paths.

3. **Header validation**: External request/correlation IDs are validated against a strict allowlist pattern to prevent header injection attacks.

4. **User-Agent truncation**: User-Agent strings are truncated to 256 characters to prevent log injection attacks.

5. **Query strings**: Avoid placing sensitive data (tokens, passwords) in URL query strings, as the full URL is logged in access logs.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Minimum log level to emit | `info` (production), `debug` (development) |
| `NODE_ENV` | Environment name (affects pretty printing) | - |
| `HOSTNAME` | Hostname for log records | `"unknown"` |
| `TRUST_PROXY` | Whether to trust `X-Forwarded-For` header for IP resolution | `"false"` |

## Migration from Winston

The project previously used Winston. Migration to Pino provides:

- **Performance**: Pino is significantly faster than Winston
- **Redaction**: Built-in redaction without external dependencies
- **Child Loggers**: Native support for request-scoped loggers
- **JSON Schema**: Consistent, queryable JSON output

If you encounter old `winston` imports, replace them with:

```typescript
// Old
import winston from 'winston';

// New
import { logger } from './logger';
```

## Querying Logs

Because logs are emitted as newline-delimited JSON, they can be easily queried using standard tools:

### Using `jq`

```bash
# Filter by level
cat logs/app.log | jq 'select(.level == "error")'

# Filter by correlation ID
cat logs/app.log | jq 'select(.correlationId == "trace-abc-123")'

# Extract specific fields
cat logs/app.log | jq '{level, message, correlationId}'
```

### Using `grep`

```bash
# Search for error messages
grep '"level":"error"' logs/app.log

# Search by correlation ID
grep '"correlationId":"trace-abc-123"' logs/app.log
```

### Using Log Aggregation Tools

The JSON format is compatible with most log aggregation systems:
- Elasticsearch + Kibana
- Splunk
- Datadog
- CloudWatch Logs Insights
- Loki + Grafana

## Best Practices

1. **Use structured context**: Pass relevant context as an object rather than string interpolation.
   ```typescript
   // Good
   logger.info('User login', { userId: '123', ip: '192.168.1.1' });

   // Bad
   logger.info(`User login for user 123 from 192.168.1.1`);
   ```

2. **Use appropriate log levels**:
   - `trace`: Detailed debugging information
   - `debug`: Debugging information for developers
   - `info`: Normal operational events
   - `warn`: Warning conditions that don't stop operation
   - `error`: Error conditions that affect operation
   - `fatal`: Critical errors that require immediate attention

3. **Propagate correlation IDs**: Always include `correlationId` when enqueueing jobs or making external service calls.

4. **Use child loggers**: Create child loggers for request-specific context to avoid repeating fields.

5. **Test redaction**: Ensure sensitive fields are properly redacted by running the test suite.

## References

- [Pino Documentation](https://getpino.io/)
- [Pino Redaction Guide](https://getpino.io/#/docs/redaction)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry Tracing](https://opentelemetry.io/docs/concepts/signals/tracing/)
