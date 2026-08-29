# feat(auth): add bulk operations endpoint

## Description
Clients issue many single auth calls. This PR adds a bounded bulk endpoint (`POST /api/v1/auth/bulk`) that processes a batch of operations and reports per-item results without failing the whole batch.

## Changes
- **`src/routes/auth.routes.ts`**: Added `bulkAuthSchema` to validate the incoming batch.
- **`src/routes/auth.routes.ts`**: Implemented `POST /api/v1/auth/bulk` which handles a bounded array of auth operations (`login`, `register`, `refresh`).
- **`src/routes/auth.routes.test.ts`**: Added comprehensive tests to cover partial-failure and over-cap cases.

## Testing
- [x] Empty batch rejected with 400
- [x] Partial failure: valid items succeed, invalid items fail and return error messages
- [x] Over-cap rejected with 400

Test Output:
```
 PASS  src/routes/auth.routes.test.ts (4.821 s)
  POST /auth/bulk
    ✓ processes a batch and reports per-item results (38 ms)
    ✓ rejects an empty batch with 400 (5 ms)
    ✓ rejects a batch exceeding 100 items with 400 (8 ms)
    ✓ handles partial failures (41 ms)

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Snapshots:   0 total
Time:        5.214 s
```
