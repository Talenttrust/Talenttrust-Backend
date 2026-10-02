# Prediction batch replay protection

`place_bets` authenticates the submitting address and rejects empty batches
before reserving a token. A nonzero `BytesN<32>` token is scoped to that caller.
A successful batch reserves it through `acceptance_ledger + 17_280`, inclusive
(approximately 24 hours). Reusing it before or at that deadline returns
`IdempotentBatchAlreadyApplied` (code 1), even with a different payload. It may
be submitted again in the next ledger as a new batch. `EmptyBatch` remains code 2.

Each reservation is a temporary entry with its own TTL, rather than a value in
the shared contract instance. New submissions and duplicate retries do not
extend other tokens. A stored ledger deadline also enforces the window when a
network minimum TTL or external rent extension retains an entry longer. The
contract instance is kept alive for the window without renewing token entries.
Expired temporary entries can be evicted independently, so new tokens do not
grow the instance map.

If ledger arithmetic overflows or the network maximum TTL is shorter than the
window, the call returns `IdempotencyRetentionUnavailable` (new code 3) before
writing state or publishing an event. Restore sufficient network retention
before retrying. No raw token or bet payload is added to diagnostics; the
existing `place_bets` event still contains the caller and batch length only.
The contract currently emits this event rather than mutating market balances.

Reservation and batch effects share one Soroban transaction. A downstream
failure rolls back both; a corrected request can retry the same token.
Conflicting transactions are serialized by the host, so only the first
successful live-token reservation can commit. Future market processing must
preserve this boundary and propagate failures instead of swallowing them.

## Upgrade compatibility

The entry-point signature, `Bet` encoding, token key encoding, exported TTL,
existing error numbers, and event remain unchanged. The deprecated all-zero
token still bypasses deduplication, but requires authentication and a nonempty
batch. Clients requiring replay protection must use a nonzero token.

Previous deployments stored boolean sentinels in instance storage without a
creation ledger. The new code continues rejecting those tokens. The first
successful nonzero-token submission after upgrade records a fixed legacy
cutoff one full window later. Legacy tokens remain rejected through that
cutoff and are lazily removed/replaced when successfully reused afterwards.
Failed submissions, duplicates, and later successes cannot reset the cutoff.
Until a new submission succeeds, legacy tokens stay protected indefinitely.
Unvisited legacy entries remain in instance storage; this change does not
enumerate or bulk-delete them. New reservations always use temporary storage.

## Verification

From the repository root, using Rust 1.91.0:

```text
cargo fmt --manifest-path contracts/Cargo.toml -- --check
cargo test --locked --manifest-path contracts/Cargo.toml
cargo clippy --locked --manifest-path contracts/Cargo.toml --all-targets -- -D warnings
cargo build --locked --manifest-path contracts/Cargo.toml
```

These tests exercise the actual Soroban host, including TTL boundaries,
independent tokens, legacy migration, permission failure and transactional
rollback. The contract CI job runs them separately from the Node backend.
These commands verify the native crate; they do not deploy or validate a Wasm
artifact on a network.

The workspace lockfile keeps the SDK's compatible dependency resolution,
including `ed25519-dalek` 2.2.0. Without a lockfile the old host's broad version
range also permits 3.0.0, which uses an incompatible random-number trait and
fails compilation. Use `--locked`; an intentional dependency update needs
contract tests before replacing this resolution.
