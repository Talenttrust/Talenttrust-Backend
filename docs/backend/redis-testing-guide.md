# Redis Testing Guide

This guide explains how Redis is used in the TalentTrust Backend testing environment, when a real Redis instance is required, and how to reproduce queue test behavior locally.

## Architecture Overview

TalentTrust uses **BullMQ** (backed by **Redis**) for background job processing. To ensure tests are fast, deterministic, and can run in environments without Redis, we employ a hybrid approach using global mocks and CI-specific service containers.

## Mocking Strategy

By default, all tests run with **Redis and BullMQ mocked**.

- **Implementation**: The mock is defined in [`src/test-setup.ts`](../../src/test-setup.ts).
- **Behavior**:
    - `ioredis` is replaced with a mock that implements basic connectivity methods (`connect`, `ping`, `close`).
    - `bullmq` classes (`Queue`, `Worker`, `QueueEvents`) are replaced with Jest mocks that simulate job enqueueing and status retrieval.
- **Benefits**: Tests run instantly without external dependencies, and API integration tests can verify job submission logic without side effects.

## When Redis is Required

While the mocks cover standard unit and API tests, a real Redis instance is required in the following scenarios:

1.  **Production and Staging**: Full BullMQ durability and concurrency features require a real Redis connection.
2.  **Health Checks**: The [`redisProbe`](../../src/health/probes.ts) attempts a real connection to verify infrastructure health.
3.  **Manual Integration Testing**: Verifying real BullMQ behavior (e.g., actual job delays, retries, or complex worker logic).
4.  **Load and Stress Testing**: Performance tests under `src/tests/load` and `src/tests/stress` require a real backing store.

## CI Configuration

In GitHub Actions, we run the full test suite with a real Redis service.

- **Workflow**: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- **Service**: A `redis:7-alpine` container is started on port `6379`.
- **Environment**:
    - `REDIS_HOST: localhost`
    - `REDIS_PORT: 6379`
    - `CI: "true"` — This flag is critical as it instructs Jest to run tests that are normally ignored locally.

## Local Reproduction

### 1. Start Local Redis

The easiest way to run a real Redis locally is via Docker:

```bash
docker run -d --name talenttrust-redis -p 6379:6379 redis:7-alpine
```

### 2. Run All Tests (Including Queue Tests)

By default, `jest.config.js` ignores `queue-manager.test.ts` and other integration-heavy files to keep local development fast. To force-run these tests:

```bash
CI=true npm test
```

### 3. Running Specific Queue Tests

If you only want to run the queue-related tests against your local Redis:

```bash
CI=true npx jest src/queue/queue-manager.test.ts
```

> [!NOTE]
> Even with `CI=true`, the mocks in `test-setup.ts` are still active. If you need to test against **real** BullMQ logic without mocks, you must temporarily comment out the `jest.mock` calls in `src/test-setup.ts`.

## Summary Table

| Environment | Redis Required | Mocked? | Includes Queue Tests? |
| :--- | :--- | :--- | :--- |
| **Local (Default)** | No | Yes | No |
| **Local (`CI=true`)** | Recommended | Yes | Yes |
| **CI (GitHub)** | Yes | Yes* | Yes |
| **Production** | Yes | No | N/A |

*\*Mocks remain active in CI to satisfy unit tests, but the infrastructure is available for integration if needed.*
