# Transaction Status Polling Specification

The Transaction Status Poller is a resilient service designed to monitor blockchain transaction finality while respecting RPC rate limits and ensuring data consistency across the backend.

## Architectural Overview

### Service Design (`TransactionPoller`)

The poller implements a recursive asynchronous pattern with exponential backoff. This ensures that:
- Network resources are conserved during extended pending states.
- API rate limits are respected through increasing retry intervals.
- The service remains resilient to transient RPC errors.

### Data Model (`Transaction`)

Transactions are tracked with the following lifecycle states:
- `PENDING`: Transaction recognized but receipt not yet available.
- `SUCCESS`: Transaction confirmed on-chain (Status: 1).
- `FAILED`: Transaction reverted (Status: 0).
- `TIMEOUT`: Transaction did not reach finality within the maximum configured retry window.

## Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxRetries` | `number` | `5` | Maximum number of polling attempts before flagging as TIMEOUT. |
| `initialDelay` | `number` | `1000ms` | Base delay for the first retry. Doubles with each subsequent attempt. |

## Polling Strategy

The delay $D_n$ for retry $n$ is calculated as:
$D_n = \text{initialDelay} \times 2^{n-1}$

Example intervals for a 1000ms base:
1. 1,000ms
2. 2,000ms
3. 4,000ms
4. 8,000ms
5. 16,000ms

## Integration Points

### POST `/api/v1/transactions`
Registers a new transaction hash for monitoring. The request is accepted immediately (`202 Accepted`), and polling occurs in the background.

### GET `/api/v1/transactions/:hash`
Retrieves the latest known state of the transaction including its receipt if available.

## Operational Considerations

- **Memory Usage**: Currently uses an in-memory database mock. For production, this should be backed by a persistent data store.
- **Error Handling**: transient RPC failures are caught and logged as warnings; the service will continue polling until the timeout limit is reached.
