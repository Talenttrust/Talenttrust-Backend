use soroban_contracterror;

/// Contract-level error codes returned as `Err(Error::)`.
///
/// ## Client handling (#1288)
///
/// | Code | Variant                         | Batch applied? | Retry with same key? |
/// |------|---------------------------------|----------------|----------------------|
/// | 1    | `IdempotentBatchAlreadyApplied` | yes (earlier)  | no — query `get_batch_receipt` |
/// | 2    | `EmptyBatch`                    | no             | yes, after fixing the batch |
/// | 3    | `IdempotencyRetentionUnavailable` | no           | yes, after fixing the ledger range |
/// | 6    | `InvalidBetAmount`              | no             | yes, after fixing the batch |
///
/// Every error is returned *before* any state is written, and Soroban
/// rolls back all writes and events of a failed invocation, so an error
/// never leaves a consumed key or a half-applied batch behind.
///
/// All variants map to a **stable `u32` discriminant** that clients and
/// off-chain tooling can pattern-match on after invoking the contract.
///
/// # Compatibility contract
///
/// The discriminant assigned to every variant is **frozen** once the contract
/// is deployed.  Changing or reusing a number would silently break any
/// on-chain or off-chain consumer that branches on the raw error code.
///
/// Rules:
/// * **Never renumber** an existing variant.
/// * **Never remove** a variant (the slot is permanently reserved).
/// * **Always append** new variants with the next unused discriminant.
/// * **Document** every reserved slot if a variant is logically deprecated
///   so future authors know not to reclaim its number.
///
/// Discriminants 4–5 remain reserved.
/// The next available discriminant is: **7**.
///
/// # Retry guidance
///
/// | Error                          | Retryable with same args? |
/// |-------------------------------|---------------------------|
/// | `IdempotentBatchAlreadyApplied` | No — generate a fresh key |
/// | `EmptyBatch`                   | No — fix the request      |
/// | `BatchTooLarge`                | No — split the batch      |
/// | `InvalidBetAmount`         | No — fix the request      |
/// | `MarketIdInvalid`              | No — fix the market_id    |
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    // ──────────────────────────────────────────────────────────────────────
    // Discriminants 1–2: original release — frozen, must not be renumbered.
    // ──────────────────────────────────────────────────────────────────────
    /// The supplied `idempotency_key` was already used in a previous
    /// `place_bets` call that completed successfully.  The original batch
    /// has already been applied; retrying within the retention window cannot
    /// apply it again. Generate a fresh `BytesN<32>` for a new batch.
    IdempotentBatchAlreadyApplied = 1,

    /// The `bets` vector was empty.  At least one [`Bet`] entry is required.
    ///
    /// Discriminant: **2** (stable).
    ///
    /// [`Bet`]: crate::bets::Bet
    EmptyBatch = 2,

    /// The ledger range or network maximum TTL cannot preserve the full
    /// replay-protection window. No token or batch effects were committed.
    IdempotencyRetentionUnavailable = 3,

    /// A bet amount was zero or negative. Validation fails before the
    /// idempotency key is consumed, so correcting the amount can be retried
    /// with the same key.
    InvalidBetAmount = 6,
}
