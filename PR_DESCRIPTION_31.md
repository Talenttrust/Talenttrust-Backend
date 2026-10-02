# refactor(audit): extract audit business logic into service layer

## Summary

Extracts all query validation, request parsing, export orchestration, input validation, and result formatting business logic from Express route handlers in `src/audit/router.ts` into `AuditService` in `src/audit/service.ts`. 

This transforms `router.ts` into a thin HTTP adapter layer and makes all audit business logic directly unit-testable at the `AuditService` layer without needing HTTP mocks or Express server instances.

---

## Key Changes

### 1. `AuditService` (`src/audit/service.ts`)
- **Query Validation & Parsing**: Moved `VALID_ACTIONS`, `VALID_SEVERITIES`, `parseOptionalIsoDate`, `parseOffset`, `parseLimit`, and `parseAuditQuery` into `service.ts`. Added `validateAndParseQuery()` method to validate raw query parameters and construct typed `AuditQuery` objects.
- **Payload Validation**: Added `createEntry(input)` method to enforce validation on required payload fields (`action`, `severity`, `actor`, `resource`, `resourceId`) before invoking `log(input)`.
- **Paginated Query Processing**: Added `queryLogs(queryParams, options)` method to process filters and format cursor-based (`{ entries, count, limit, nextCursor }`) or offset-based (`{ entries, count, limit, offset }`) results.
- **NDJSON Compliance Export**: Added `exportAuditLogs(queryParams, context, exportService)` method to parse export filters, invoke `AuditExportService.createNdjsonExport()`, and log compliance `ADMIN_ACTION` entries.
- **Integrity Status Mapping**: Added `checkIntegrity()` method to invoke `verifyIntegrity()` and return `{ report, status }` (status 200 for valid, 409 for invalid/corrupted).
- **ID Retrieval**: Added `getEntry(id)` helper method delegating to `getById(id)`.

### 2. Router Layer (`src/audit/router.ts`)
- Refactored Express handlers (`POST /`, `GET /`, `GET /export`, `GET /integrity`, `GET /:id`) to act as thin HTTP adapters that extract request parameters (`req.body`, `req.query`, `req.user`, `req.ip`, `res.locals['requestId']`), delegate logic execution to `AuditService`, and set HTTP status headers and responses.

### 3. Unit Tests (`src/audit/service.test.ts`)
- Added unit tests covering all extracted `AuditService` business logic methods:
  - Validation error handling for unknown actions/severities, invalid limits, negative offsets, malformed ISO dates, and invalid cursors.
  - Required payload validation in `createEntry`.
  - Pagination formatting in `queryLogs` (cursor vs offset).
  - Export filter extraction and compliance logging in `exportAuditLogs`.
  - Status mapping in `checkIntegrity`.

---

## Backward Compatibility & Safety Guarantees

- **100% Backward Compatible**: All REST API endpoint URL paths, HTTP status codes, error message strings, response payload keys, and `createAuditRouter()` options remain unchanged.
- **Zero New Dependencies**: Implemented strictly with existing dependencies.

---

## Test Results & Code Coverage

### Unit Test Execution Output

```
PASS src/audit/service.test.ts
PASS src/audit/router.validation.test.ts
PASS src/audit/router.integration.test.ts

Test Suites: 3 passed, 3 total
Tests:       167 passed, 167 total
Snapshots:   0 total
Time:        25.507 s
Ran all test suites matching /src\audit\service.test.ts|src\audit\router.validation.test.ts|src\audit\router.integration.test.ts/i.
```

### Coverage Report

```
------------|---------|----------|---------|---------|---------------------
File        | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s   
------------|---------|----------|---------|---------|---------------------
All files   |     100 |    92.74 |     100 |     100 |                     
 router.ts  |     100 |    91.66 |     100 |     100 | 67,137              
 service.ts |     100 |       93 |     100 |     100 | 216-233,253,307,382 
------------|---------|----------|---------|---------|---------------------
```

---

## How to Verify

1. Run unit tests for the audit module:
   ```bash
   npx jest src/audit/service.test.ts src/audit/router.validation.test.ts src/audit/router.integration.test.ts
   ```
2. Verify TypeScript compilation:
   ```bash
   npx tsc --noEmit --skipLibCheck src/audit/service.ts src/audit/router.ts src/audit/service.test.ts
   ```
