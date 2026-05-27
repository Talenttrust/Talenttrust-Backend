# Error Message Security Policy

This document defines the safe error message policy enforced by the TalentTrust backend. The goal is to prevent information disclosure through API error responses (CWE-209, OWASP A01:2021).

## Principles

1. **Never expose internals.** Stack traces, file paths, SQL fragments, dependency paths, and raw syscall error codes are never included in API responses, regardless of `NODE_ENV`.
2. **Stable machine codes.** Every error response includes a machine-readable `code` field that clients can rely on for programmatic handling. These codes do not change between releases without a migration notice.
3. **Safe human-readable messages.** The `message` field contains a helpful but non-revealing description. If an error message is detected to contain unsafe content, it is replaced by the canonical fallback for its code.
4. **Consistent envelope.** All error responses use the same JSON shape:
   ```json
   {
     "error": {
       "code": "machine_readable_code",
       "message": "safe human-readable message",
       "requestId": "correlation-id"
     }
   }
   ```

## Machine Code Registry

| Code                     | HTTP Status | Canonical Message                                    |
| ------------------------ | ----------- | ---------------------------------------------------- |
| `internal_error`         | 500         | An unexpected error occurred                         |
| `invalid_json`           | 400         | Malformed JSON payload                               |
| `validation_error`       | 400         | Request validation failed                            |
| `not_found`              | 404         | The requested resource was not found                 |
| `unauthorized`           | 401         | Authentication is required                           |
| `forbidden`              | 403         | You do not have permission to perform this action    |
| `dependency_unavailable` | 503         | A required service is temporarily unavailable        |
| `rate_limited`           | 429         | Too many requests — please try again later           |
| `conflict`               | 409         | The request conflicts with the current state         |
| `bad_request`            | 400         | The request could not be processed                   |

## Implementation

The policy is implemented in `src/errors/safeErrors.ts` and enforced by:

- **`mapErrorToPayload()`** in `src/errors/appError.ts` — the canonical error serializer used by the envelope error handler.
- **`errorHandler()`** in `src/middleware/errorHandlers.ts` — the global Express error handler mounted in `app.ts`.
- **`errorHandler()`** in `src/middleware/errorHandler.ts` — the alternative handler used by some route modules.
- **`errorHandler()`** in `src/middleware/error.middleware.ts` — the legacy handler retained for backward compatibility.

### Sanitization

`sanitizeErrorMessage(message, code)` checks the message against a list of forbidden patterns. If any match is found, the canonical fallback for the error code is returned instead.

Forbidden patterns include:
- V8 stack frames (`at Module._compile (...)`)
- Absolute file paths (`/src/app.ts:12`)
- `node_modules/` references
- Raw syscall errors (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`)
- SQL fragments (`SELECT`, `INSERT`, etc.)
- Credential-related field names (`password`, `secret`, `token`, `apikey`)

## Testing

The policy is enforced by:

1. **Unit tests** (`src/errors/safeErrors.test.ts`) — verify that `containsUnsafeContent`, `safeMessageForCode`, and `sanitizeErrorMessage` behave correctly for all known safe and unsafe patterns.
2. **Integration tests** (`src/errors/errorMessagePolicy.integration.test.ts`) — fire HTTP requests at the running application and assert that no response body contains forbidden patterns, and that the envelope shape and machine codes are stable.
3. **Existing handler tests** — updated to assert that stack traces are never present and that 500 responses always use safe generic messages.

## Security Notes

- Server-side logging (`console.error`) still receives the full error including stack traces for debugging purposes.
- The `expose` flag on `AppError` controls whether the developer-provided message is used (after sanitization) or replaced entirely with the canonical fallback.
- Validation errors intentionally include field-level detail (e.g., "name is required") since these are user-facing input guidance, not internal implementation leakage.
