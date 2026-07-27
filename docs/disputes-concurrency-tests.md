# Disputes Concurrency Smoke Tests

## Overview

This document describes the concurrency smoke tests for the disputes endpoint, which were added to uncover race conditions and ensure no lost updates occur under concurrent load.

## Purpose

The disputes endpoint wasn't tested under concurrency, which could hide race conditions. These tests fire concurrent requests and assert consistent state with no lost updates. They are deterministic and bounded (no real network calls) to provide fast, reliable feedback.

## Test Files

- `src/routes/disputes.concurrency.test.ts` - Main concurrency test suite

## Test Coverage

### Service-Level Tests

These tests directly exercise the `DisputesService` to test concurrent operations at the data layer:

1. **parallel writes: 10 concurrent createDispute calls produce 10 disputes with no lost updates**
   - Fires 10 concurrent `createDispute` operations
   - Verifies all disputes are created and retrievable
   - Ensures no lost updates in the in-memory Map store

2. **parallel writes: 20 concurrent updates to same dispute produce consistent final state**
   - Fires 20 concurrent `updateDispute` operations on the same dispute
   - Verifies all updates succeed with consistent final state
   - Tests last-write-wins behavior under concurrency

3. **parallel writes: each created dispute is retrievable by id after concurrent creates**
   - Creates disputes concurrently
   - Verifies each dispute can be retrieved by its ID
   - Ensures no ID collisions or lost references

4. **read-after-write consistency: listDisputes during concurrent creates never loses updates**
   - Fires concurrent creates while running concurrent list operations
   - Verifies list operations see consistent counts
   - Tests read-after-write consistency under load

5. **parallel writes: state transitions remain valid under concurrent updates**
   - Fires concurrent valid state transitions
   - Verifies all transitions remain valid
   - Ensures state machine integrity under concurrency

6. **parallel writes: 50 concurrent creates produce correct count with no lost updates**
   - Stress test with 50 concurrent creates
   - Verifies correct count and unique IDs
   - Tests scalability of concurrent operations

7. **parallel batch operations: multiple concurrent processBatch calls handle isolation**
   - Fires concurrent batch operations on different disputes
   - Verifies each batch operation is isolated
   - Tests batch processing under concurrency

8. **parallel mixed operations: creates, updates, and reads run concurrently without corruption**
   - Fires mixed concurrent operations (creates, updates, reads)
   - Verifies no errors or data corruption
   - Tests realistic mixed workload scenarios

### HTTP Endpoint-Level Tests

These tests exercise the HTTP routing layer to ensure middleware and request handling work correctly under concurrency:

1. **GET /api/v1/disputes: concurrent reads all succeed with 200**
   - Fires 20 concurrent GET requests to list endpoint
   - Verifies all requests succeed with correct response structure
   - Tests routing and middleware under concurrent load

2. **GET /api/v1/disputes/:id: concurrent reads of different IDs all succeed**
   - Fires 15 concurrent GET requests to different dispute IDs
   - Verifies all requests succeed with proper validation
   - Tests parameter validation under concurrency

3. **mixed HTTP methods: concurrent GET requests to different endpoints handle without errors**
   - Fires concurrent requests to list and single endpoints
   - Verifies no errors occur under mixed concurrent load
   - Tests routing isolation between endpoints

4. **concurrent requests with different IPs are handled independently**
   - Fires concurrent requests from different IPs
   - Verifies rate limiting and middleware handle IP isolation
   - Tests per-client isolation under concurrency

5. **feature flag: concurrent requests respect feature flag state**
   - Fires concurrent requests when feature is disabled
   - Verifies all requests return 404 with correct error code
   - Tests feature flag behavior under concurrency

## Race Conditions Found and Fixed

### 1. Router Definition Bug (Fixed)

**Issue**: The `disputes.routes.ts` file had a structural bug where the feature flag middleware referenced `router` before it was defined, and the route handlers were defined outside the function scope.

**Fix**: 
- Moved the feature flag middleware inside the `createDisputesRouter` function
- Moved all route handlers inside the function scope
- Added proper `return router` statement
- Added missing imports for `createDisputesController`, `Logger`, and `MetricsServiceLike`
- Implemented the missing `createDisputesObservabilityMiddleware` function

**Impact**: This was a critical bug that would have caused the router to fail at runtime.

### 2. Service Store Persistence (Fixed)

**Issue**: The `DisputesService` uses a shared in-memory Map that persisted across test runs, causing test pollution and incorrect assertions.

**Fix**: Added `service.clearStore()` in the `beforeEach` hook to ensure a clean state for each test.

**Impact**: Without this fix, tests would fail due to accumulated state from previous tests.

## Coverage Targets

The current coverage thresholds for disputes-related modules (from `jest.config.js`):

```javascript
'./src/services/disputes.service.ts': {
  lines: 90,
  branches: 80,
  functions: 90,
  statements: 90,
}
```

The new concurrency tests help achieve these targets by covering:
- Concurrent write paths
- Concurrent read paths
- Mixed operation scenarios
- Error handling under concurrency

## Running the Tests

```bash
# Run only the concurrency tests
npm test -- src/routes/disputes.concurrency.test.ts

# Run with coverage
npm test -- src/routes/disputes.concurrency.test.ts --coverage

# Run in band (sequential execution)
npm test -- src/routes/disputes.concurrency.test.ts --runInBand
```

## Design Principles

1. **Deterministic**: Tests use controlled concurrency with `await Promise.resolve()` to yield to the event loop, ensuring reproducible results.

2. **Bounded**: Tests use fixed counts (10, 20, 50) rather than unbounded loops, ensuring fast execution.

3. **No Real Network**: All tests use in-memory operations and mocked HTTP, avoiding external dependencies.

4. **Isolation**: Each test clears shared state before execution, preventing test pollution.

5. **Fast**: Tests complete in under 10 seconds, suitable for CI/CD pipelines.

## Future Enhancements

Potential areas for additional concurrency testing:

1. **Database-Level Concurrency**: Add tests for SQLite-based dispute storage when implemented
2. **Rate Limiting Under Concurrency**: Test rate limiter behavior with concurrent requests
3. **Cache Invalidation**: Test cache invalidation under concurrent writes
4. **Distributed Locking**: Test distributed locking mechanisms if implemented
5. **Transaction Isolation**: Test transaction boundaries under concurrent operations

## References

- Original audit concurrency tests: `src/audit/concurrency.test.ts`
- Disputes service: `src/services/disputes.service.ts`
- Disputes routes: `src/routes/disputes.routes.ts`
- Disputes controller: `src/controllers/disputes.controller.ts`
