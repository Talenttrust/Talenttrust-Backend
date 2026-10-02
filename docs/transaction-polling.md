# Transaction Polling

The `TransactionPoller` is a specialized background orchestrator designed to track the confirmation status of blockchain transactions reliably. Because blockchain finality can be delayed, applications must poll the RPC endpoints to determine whether a transaction succeeded (was mined) or reverted.

## Architecture

The Poller uses:
1. **Durable Persistence**: `src/models/Transaction.ts` wraps an underlying SQLite table (`transactions`) to record polling state.
2. **Full-Jitter Backoff**: To avoid "thundering herd" or stampede problems when many transactions are pending, `pollWithBackoff` uses a randomized exponential backoff strategy.
3. **Circuit Breaking**: The poller gives up after `maxRetries` attempts, marking the transaction as `TIMEOUT`.

## Persistence & State

Transactions tracked by the system exist in a state machine:
- `PENDING`: Initial state, polling is active.
- `SUCCESS`: Transaction was mined successfully.
- `FAILED`: Transaction was reverted on-chain.
- `TIMEOUT`: The transaction took too long and the circuit breaker tripped.

Whenever a transaction's state or retry count changes, `transactionsDb.set()` ensures it is immediately persisted to the SQLite database. This guarantees that no state is lost if the Node.js process restarts.

## Retry and Jitter Backoff

When polling for a `PENDING` transaction, the poller checks the network. If the transaction is not yet finalized, it schedules a subsequent check using a delay calculated by:

```javascript
calculateDelay(retryCount - 1, initialDelay, Infinity, true)
```

With `jitter: true`, the expected interval is not uniformly doubled, but instead randomized (scaled by `0.5 + Math.random() * 0.5`). This ensures that if the system reboots and begins checking hundreds of pending transactions concurrently, their RPC calls quickly desynchronize, preventing rate-limit violations.

## Recovery Routine

During application boot, the system calls `TransactionPoller.recoverPendingTransactions()`. This routine:
1. Queries all transactions from the database where `status === 'PENDING'`.
2. Iterates over them and calls `pollWithBackoff(txHash)`.
3. Background polling resumes transparently.

Because of the exponential backoff, transactions that had already accumulated a high `retryCount` before the restart will resume with a long delay, rather than hitting the network immediately.

## Lease Fencing (multi-instance safety)

Each transaction row carries a poll lease (`lease_owner` + `lease_expires_at`). A lease prevents two poller instances from updating the same transaction after the lease owner has changed:

- **Acquisition**: `poll()` and `recoverPendingTransactions()` acquire the lease before polling. A transaction whose lease is held by a *live* owner is skipped/deferred — only one instance polls it at a time.
- **Renewal**: the lease is renewed immediately before every RPC call, so a long-running poll keeps its lease fresh without abandoning.
- **Fencing**: every state write is a compare-and-swap (`setIfLeaseOwner`) that only applies while the stored `lease_owner` still matches the writer's token. If the lease expired while an RPC call was in flight and another instance took over, the old worker's late write is rejected and the poll is **abandoned and reported** (structured `warn` log + optional `onPollAbandoned` callback + `abandonedPolls` counter) so the work can be retried by the new owner.
- **Recovery after restart**: only transactions whose lease has expired (the previous process is dead) or is unowned are resumed; transactions with a live foreign lease are skipped.

Operational tuning (see `TransactionPollerOptions`):
- `leaseDurationMs` (default 30s) bounds how long an in-flight RPC may outlive its owner before the transaction becomes stealable. Keep it comfortably above the expected RPC latency.
- `leaseSkewMs` (default 5s) is a clock-skew tolerance: a lease is only considered expired when `expiresAt + skewMs < now`. This prevents a node with a slightly fast clock from stealing a lease that the owner still considers valid.
- `leaseToken` defaults to a per-instance UUID, so every poller in a process group has a distinct fencing identity.

On the SQLite store, lease acquisition runs inside an exclusive transaction (`BEGIN IMMEDIATE` where available) so concurrent processes sharing the database file cannot both acquire the same lease; the fenced write is a single atomic `UPDATE … WHERE lease_owner = ?` statement.
