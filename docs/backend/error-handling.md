# Backend Error Handling and Status-Code Guarantees

This document defines the backend error envelope, expected status codes, and security behavior.

## Error Envelope

All handled API errors return the same JSON shape:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "safe human-readable message",
    "requestId": "request-correlation-id"
  }
}
```

## Status-Code Policy

- `400` for malformed JSON payloads (`invalid_json`) and request validation failures (`validation_error`)
- `404` for unknown routes (`not_found`)
- `503` for expected dependency outages (`dependency_unavailable`)
- `500` for unexpected failures (`internal_error`)

## Security Notes

- Internal exception details are never exposed in error responses, regardless of `NODE_ENV`.
- Every response carries `x-request-id` for incident correlation.
- API errors include the same `requestId` to simplify tracing while avoiding sensitive leakage.
- Error messages are sanitized against known unsafe patterns (stack traces, file paths, SQL, credentials). See [`error-message-policy.md`](error-message-policy.md) for the full policy.

## Threat Scenarios Considered

- Parser-level malformed JSON attacks.
- Route probing and unknown endpoint access.
- Dependency outage or upstream unavailability.
- Unexpected runtime exceptions with sensitive message contents.

## Tests

- Unit tests verify deterministic error mapping to status and response shape.
- Integration tests verify status-code correctness and envelope consistency for edge and failure paths.

### errorHandler middleware coverage

`src/middleware/errorHandlers.test.ts` provides isolated unit coverage for the
terminal error-handling middleware. It drives the handler with mock req/res/next
(no live server) and asserts:

| Scenario | Assertions |
|---|---|
| `AppError` | status code, safe message via `SAFE_ERROR_MESSAGES`, code, requestId |
| `ZodError` | 400, `validation_error`, canonical message, field-level `details` |
| Body-parser `SyntaxError` | 400, `invalid_json`, no raw token text |
| Unknown `Error` / thrown value | 500, `internal_error`, no stack or internal message |
| Correlation ID | echoed in logger when present; absent from logger when not set |
| Logger | always called exactly once with redacted error content |
| `res.locals.log` | per-request child logger is preferred over module logger |
| `res.headersSent` | handler is a no-op — no status/json calls |
| `req.streamError` | overrides the passed error argument |
| `notFoundHandler` | delegates a 404 `AppError` to `next` |

**Security validation** — every response body is asserted to contain no
`stack` property and no message text outside the `SAFE_ERROR_MESSAGES` registry,
covering OWASP A01:2021 / CWE-209 (information disclosure).

See [`error-message-policy.md`](error-message-policy.md) for the full safe-message policy.
