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

- Internal exception details are not exposed in `500` responses.
- Every response carries `x-request-id` for incident correlation.
- API errors include the same `requestId` to simplify tracing while avoiding sensitive leakage.

## Threat Scenarios Considered

- Parser-level malformed JSON attacks.
- Route probing and unknown endpoint access.
- Dependency outage or upstream unavailability.
- Unexpected runtime exceptions with sensitive message contents.

## Tests

- Unit tests verify deterministic error mapping to status and response shape.
- Integration tests verify status-code correctness and envelope consistency for edge and failure paths.
