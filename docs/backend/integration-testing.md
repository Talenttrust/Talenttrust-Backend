# Backend Integration Testing

## Overview

The backend now includes a focused integration test suite for the API surface. The suite verifies representative success and failure behavior without relying on external services or mutable shared state.

## Test architecture

The production server bootstrap was split into two small pieces:

- `src/app.ts` creates an importable Express app
- `src/index.ts` starts the HTTP server

This keeps production behavior intact while allowing tests to instantiate the app directly without binding to a port.

## Isolation strategy

- Tests use an in-memory `ContractService`
- Each app instance gets its own service state
- No external database or network dependency is required
- No production services are called

## Covered API flows

- `GET /health`
- `GET /api/v1/contracts`
- `GET /api/v1/contracts/:id`
- `POST /api/v1/contracts`

## Covered failure paths

- malformed JSON
- missing required request fields
- invalid path identifiers
- duplicate resource creation
- unauthorized role/ownership style misuse via self-dealing protection
- unknown contract lookup
- unknown route
- unsupported method under current router behavior
- unexpected internal error sanitization

## Security assumptions validated

- malformed input is rejected
- invalid identifiers are rejected before lookup
- internal errors do not leak implementation details
- duplicate creation conflicts are handled consistently
- self-dealing contract creation is denied
- tests do not contact external systems

## How to run

```bash
npm test
npm run build
```

To inspect coverage:

```bash
npm test -- --coverage
```

## Limitations

- The backend currently has a small API surface and no persistent database integration yet, so tests focus on the present app behavior and in-memory service layer.
- Auth middleware does not exist in the current repo, so authentication-specific integration cases are not added beyond the present business-rule enforcement.
