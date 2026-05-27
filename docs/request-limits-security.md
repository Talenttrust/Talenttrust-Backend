# Request Limits Security Architecture

This document describes the design and configuration of the streaming request body-size limit enforcer implemented in TalentTrust.

## 1. Threat Model & Security Goals

### Threats Mitigated
- **Denial of Service (DoS) / Memory Exhaustion**: Attackers sending exceptionally large payloads (e.g. gigabytes of data via chunked transfer encoding) to endpoints. Traditional body-parsers buffer the entire body into memory before returning a size limit error, leading to memory exhaustion and application crashes.
- **Resource Deprivation**: Large file uploads occupying worker threads, event loop ticks, or connection pools.
- **Information Leakage**: Verbose HTTP error responses revealing the platform's internal paths, stack traces, or dependencies.

### Security Goals
- **Early Abort**: Intercept requests early in the HTTP lifecycle—prior to body parsing—and immediately sever connections for oversized payloads.
- **Header & Stream Enforcement**: Validate both `Content-Length` headers and actual byte counts during streaming (to defend against chunked encoding and tampered/missing headers).
- **Safe Responses**: Return a sanitized, static `413 Payload Too Large` error, hiding all attacker-controlled variables and internal details.
- **Fail-Safe Startup Configuration**: Parse and validate all request limit settings at server start to prevent running with invalid or insecure limits.

---

## 2. Design & Architecture

The request limits enforcement consists of a global Express middleware registered at the top of the middleware stack.

```mermaid
graph TD
    A[Incoming Request] --> B{Path Excluded?}
    B -- Yes --> C[Bypass Validation & Process Route]
    B -- No --> D{Content-Length > Limit?}
    D -- Yes --> E[Abort: 413 Payload Too Large]
    D -- No / Absent --> F[Attach Stream Listener & Call next()]
    F --> G[Data Chunk Received]
    G --> H{Bytes Count > Limit?}
    H -- Yes --> I[Destroy Stream req.destroy & Set streamError]
    H -- No --> J[Continue Stream Parsing]
    I --> K[Body Parser / Router Fails]
    K --> L[Global Error Handler Catches streamError & returns 413]
```

### Raw Stream Interception
The `requestLimitsMiddleware` is registered *before* `express.json()` in the middleware pipeline:
```typescript
app.use(requestLimitsMiddleware);
app.use(express.json());
```
This allows the middleware to check `Content-Length` headers and attach event listeners to the request stream before any other middleware buffers the data.

### Double-Garded Enforcement
1. **Header Verification**: If the client provides a `Content-Length` header exceeding the limit, the request is immediately rejected without reading a single byte from the socket.
2. **Stream Counting**: For chunked transfer encoding (where `Content-Length` is absent) or header tampering, the middleware monitors incoming `'data'` events and maintains a running counter of the bytes read. If the counter exceeds the route-specific limit, the middleware detaches all listeners, calls `req.destroy()`, and records a `streamError` on the request.

### Stream Destruction & Error Handling
Calling `req.destroy()` terminates the incoming readable stream and closes the socket, immediately halting the upload. 
When the next body-parsing middleware tries to consume the destroyed stream, it fails and propagates the failure to the global error handler. The error handler intercepts the custom `req.streamError` property and responds to the client with a safe 413 error status.

---

## 3. Configuration & Startup Validation

All request limits are configurable via environment variables and validated at startup using a Zod schema in `src/config/env.schema.ts`. If an environment variable is invalid, the application fails to start.

### Environment Variables
| Variable Name | Description | Default | Validation |
|---|---|---|---|
| `MAX_REQUEST_BODY_SIZE` | Global fallback maximum request body size (in bytes). | `1048576` (1MB) | Positive integer |
| `ENFORCE_JSON_CONTENT_TYPE` | Enforces JSON content-type on writing requests (POST/PUT/PATCH/DELETE). | `true` | Boolean (`true`/`false`) |
| `ALLOWED_CONTENT_TYPES` | Comma-separated list of allowed content types. | `application/json` | Array of strings |
| `REQUEST_LIMITS_EXCLUDE_PATHS` | Comma-separated list of paths excluded from limits. | `/health, /metrics` | Array of strings |
| `ROUTE_BODY_LIMITS` | Comma-separated list of route-specific limits in `route:limit` format. | (none) | Map of `path: positive_integer` (e.g. `/api/v1/contracts:2048`) |

---

## 4. Safe Error Responses

TalentTrust adheres to a strict safe error message policy (defined in `src/errors/safeErrors.ts`). Under this policy:
- No user-supplied content is reflected in error messages.
- The machine-readable code returned is `payload_too_large` or `unsupported_media_type`.
- The human-readable messages returned are static strings:
  - `payload_too_large` -> `"Payload Too Large"`
  - `unsupported_media_type` -> `"Unsupported Media Type"`
