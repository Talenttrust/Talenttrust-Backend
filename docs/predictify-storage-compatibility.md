# Predictify storage compatibility

`place_bets` retains its existing arguments, `Bet` fields, caller authentication,
empty-batch validation, events, and deprecated all-zero token opt-out. Existing
errors `IdempotentBatchAlreadyApplied = 1` and `EmptyBatch = 2` keep their codes.

The instance-storage marker key remains the Soroban vector
`[Symbol("PlaceBetsIdem"), caller Address, token BytesN<32>]`. A successful
nonzero-token batch writes the boolean `true`, readable by existing clients.
Renaming the enum variant, reordering its fields, changing token length or
moving records to another storage namespace requires a tested migration.

Only an absent marker permits a new reservation. A `true` marker returns the
existing duplicate error. A `false` marker or any other value is invalid saved
state: return `InvalidIdempotencyState = 4`, without clearing, repairing or
replacing it and without applying the batch. This new diagnostic code replaces
the old duplicate error for malformed markers only; valid callers need no
migration. The code reveals no stored contents. Clients should not blindly
retry an invalid-state error or submit another token to bypass it; operators
must investigate the affected deployment and recover from verified state.
An old generated client still decodes errors 1 and 2, and safely reports the
new error 4 as an unknown contract error. Update its error mapping to label
invalid saved state explicitly; the call arguments and payload do not change.

Authorization and empty-batch validation precede marker inspection. Reservations
and events commit in the same Soroban transaction, and conflicting writes are
serialized by the host. Failed validation and retries cannot turn invalid
saved state into a fresh key. Different caller addresses and different tokens
remain independent.

This change retains the existing shared instance TTL behavior. It does not
implement independent token expiry or change the window. The TTL redesign in
the separate issue #1292 / PR #1511 also modifies this module and must preserve
these legacy wire, validation and failure contracts when the two changes are
integrated. Boolean legacy records must be validated before any migration;
new deadline records require their own validation and compatibility tests.

Run the host-backed compatibility tests with:

```sh
cargo test --locked --manifest-path contracts/Cargo.toml storage_compatibility_tests
```

The lockfile makes the SDK's native test dependency resolution reproducible;
the Cargo manifests and SDK requirement remain unchanged. The compatibility
suite seeds independently encoded legacy keys and tests successful writes,
duplicate and malformed rejection, caller/token separation, authorization,
empty-batch precedence, zero-token behavior and stable error codes.
