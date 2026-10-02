# Soroban RPC Integration Service

The `SorobanRpcService` provides a clean interface for the TalentTrust backend to interact with the Soroban network (Stellar). It abstracts away the raw setup of the `@stellar/stellar-sdk` RPC server and exposes the primary functions needed for our smart contract interactions.

## Configuration

The service leverages environment variables loaded via `src/config/index.ts`.

- `SOROBAN_RPC_URL`: The URL of the Soroban RPC endpoint (default: `https://rpc-futurenet.stellar.org:443`).
- `SOROBAN_NETWORK_PASSPHRASE`: The network passphrase (default: `Test SDF Future Network ; October 2022`).

The Stellar RPC client (`src/rpc/stellarClient.ts`) honours additional production-grade transport knobs (validated by `src/rpc/stellarConfig.ts` and mirrored in `src/config/env.schema.ts`):

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `STELLAR_RPC_TIMEOUT_MS` | `5000` | `1..120000` | Per-attempt `AbortController` timeout. Throws a typed `StellarTimeoutError` if exceeded. |
| `STELLAR_RPC_MAX_RETRIES` | `3` | `0..10` | Number of retries **after** the first try. Total attempts = `MAX_RETRIES + 1`. |
| `STELLAR_RPC_RETRY_BASE_DELAY_MS` | `200` | `0..60000` | Initial exponential-backoff delay (ms). |
| `STELLAR_RPC_RETRY_MAX_DELAY_MS` | `2000` | `0..60000` | Cap (ms) on any individual backoff sleep. Must be ≥ base delay. |

Invalid env values (non-integer, out of range, `MAX < BASE`) cause the application to fail at boot — the defaults are not silently substituted, so misconfiguration is loud.

## Usage

You can import the instantiated service directly:

```typescript
import { sorobanRpcService } from '../index'; // or adjust path

// 1. Reading Contract Data
const contractId = 'C...';
const key = StellarSdk.xdr.ScVal.scvSymbol('MyKey');
const data = await sorobanRpcService.getContractData(contractId, key);

// 2. Simulating a Transaction
const simResult = await sorobanRpcService.simulateTransaction(transaction);

// 3. Submitting a Transaction
const sendResponse = await sorobanRpcService.sendTransaction(signedTransaction);

// 4. Polling for Transaction Status
const status = await sorobanRpcService.getTransactionStatus(sendResponse.hash);
if (status.status === 'SUCCESS') {
    // Transaction merged into the ledger
}
```

## Transport Resilience: Timeout & Retries

The default transport (`defaultTransport` in `src/rpc/stellarClient.ts`) is **not** a bare `fetch`. It is composed of:

1. **Per-attempt timeout** — every fetch attempt is wrapped in an `AbortController`
   whose `abort()` fires after `STELLAR_RPC_TIMEOUT_MS`. The transport converts
   the platform-specific `AbortError` into a typed `StellarTimeoutError` so
   callers can branch on it without string matching.
2. **Bounded HTTP retries** — the transport runs each request through
   `withRetry` (from `src/utils/retry.ts`) with exponential backoff and
   jitter. The budget is `STELLAR_RPC_MAX_RETRIES + 1` total attempts.

### Retry classification

| Error | Retry? | Why |
| --- | --- | --- |
| `StellarTimeoutError` | ✅ | Transient — timeout may clear on next attempt. |
| 5xx `StellarRpcError` | ✅ | Gateway / server-side issue may resolve. |
| 429 `StellarRpcError` | ✅ | Explicit rate-limit; back-off and retry. |
| 4xx (other) `StellarRpcError` | ❌ | Caller-side error; retrying won't help. |
| `SyntaxError` (JSON parse) | ❌ | Structural problem; retrying won't help. |
| Other unknown errors | ✅ | Default-on so network blips are absorbed. |

### Layering with the Circuit Breaker

Because retries live **inside** the transport, the `CircuitBreaker` observes
exactly **one** outcome per logical call: a single success (after 0..N
retries recovered) or a single failure (after the retry budget was exhausted).

This means a transient blip that heals within the retry budget does **not**
count multiple times against the breaker's 5-failure threshold — important
because retry-amplified counts would otherwise trip the breaker prematurely.

## Circuit Breaker Protection

All Soroban RPC calls are routed through a `CircuitBreaker` instance (`stellar-rpc`) that prevents cascading failures when the Stellar network degrades. See [Circuit Breaker documentation](./circuit-breaker.md) for the state machine, configuration, and admin operations.

## Typed Errors

The transport raises distinct error classes so route handlers can map RPC
failures to the correct HTTP status:

- `StellarTimeoutError` — `timeoutMs`, `url` fields exposed. The breaker counts this as a failure.
- `StellarRpcError` — `status`, `data` fields exposed. Use for non-retryable 4xx and post-retry 5xx outcomes.
- `CircuitOpenError` (from `../circuit-breaker`) — the upstream was protected against; respond with HTTP 503.

## Testing

Tests live in `src/rpc/stellarClient.test.ts` and cover:

- Successful single-attempt calls.
- Timeout paths (AbortController fires → `StellarTimeoutError`).
- Retry recovery (transient error → success on attempt N+1).
- Retry exhaustion (all attempts fail → final error surfaces).
- 4xx short-circuits (not retried, call count = 1).
- 5xx and 429 retried within budget.
- Backoff is exponential and bounded.
- `StellarClient.call` integrates with the circuit breaker correctly.
- `loadStellarRpcConfig` rejects invalid env values (zero timeout, non-integer, out-of-range).

Run via:

```bash
npm run test -- --coverage src/rpc/stellarClient.test.ts
```
