use soroban_sdk::contracterror;

/// Contract-level error codes returned as `Err(Error::)`.
///
/// ## Client handling (#1288)
///
/// | Code | Variant                         | Batch applied? | Retry with same key? |
/// |------|---------------------------------|----------------|----------------------|
/// | 1    | `IdempotentBatchAlreadyApplied` | yes (earlier)  | no — query `get_batch_receipt` |
/// | 2    | `EmptyBatch`                    | no             | yes, after fixing the batch |
/// | 3    | `InvalidAmount`                 | no             | yes, after fixing the batch |
/// | 4    | `BatchTooLarge`                 | no             | yes, after splitting (new keys) |
/// | 5    | `AmountOverflow`                | no             | yes, after fixing the batch |
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
/// Currently reserved discriminants: 1–4.
/// The next available discriminant is: **5**.
///
/// # Retry guidance
///
/// | Error                          | Retryable with same args? |
/// |-------------------------------|---------------------------|
/// | `IdempotentBatchAlreadyApplied` | No — generate a fresh key |
/// | `EmptyBatch`                   | No — fix the request      |
/// | `BatchTooLarge`                | No — split the batch      |
/// | `AmountMustBePositive`         | No — fix the request      |
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

    /// A saved idempotency marker or migration deadline has an unknown value
    /// shape. The call wrote nothing. Use a fresh token and investigate the
    /// preserved record before attempting to repair it through an upgrade.
    InvalidIdempotencyState = 4,
}
