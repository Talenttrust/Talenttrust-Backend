use soroban_sdk::contracterror;

/// Contract-level error codes returned as `Err(Error::*)`.
///
/// ## Client handling
///
/// | Code | Variant                        | Batch applied? | Retry with same key? |
/// |------|--------------------------------|----------------|----------------------|
/// | 1    | `IdempotentBatchAlreadyApplied`| yes (earlier)  | no — generate a fresh key |
/// | 2    | `EmptyBatch`                   | no             | yes, after fixing the batch |
/// | 3    | `IdempotencyRetentionUnavailable` | no          | no — network cannot honour the window |
/// | 4    | `BatchTooLarge`                | no             | yes, after splitting (new keys) |
/// | 5    | `AmountMustBePositive`         | no             | yes, after fixing the batch |
/// | 6    | `MarketIdInvalid`              | no             | yes, after fixing the batch |
///
/// Every error is returned *before* any state is written, and Soroban rolls
/// back all writes and events of a failed invocation, so an error never leaves
/// a consumed key or a half-applied batch behind.
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
/// Currently reserved discriminants: 1–6.
/// The next available discriminant is: **7**.
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
    ///
    /// Discriminant: **1** (stable).
    IdempotentBatchAlreadyApplied = 1,

    /// The `bets` vector was empty.  At least one [`Bet`] entry is required.
    ///
    /// Discriminant: **2** (stable).
    ///
    /// [`Bet`]: crate::bets::Bet
    EmptyBatch = 2,

    /// The ledger range or network maximum TTL cannot preserve the full
    /// replay-protection window. No token or batch effects were committed.
    ///
    /// Discriminant: **3** (stable).
    IdempotencyRetentionUnavailable = 3,

    // ──────────────────────────────────────────────────────────────────────
    // Discriminants 4–6: validation boundaries — frozen.
    // ──────────────────────────────────────────────────────────────────────
    /// The `bets` vector exceeds the per-invocation limit defined by
    /// [`crate::storage::MAX_BATCH_SIZE`].  Split the submission into smaller
    /// chunks and submit each independently with a distinct idempotency key.
    ///
    /// This bound prevents a single invocation from consuming an unbounded
    /// amount of host CPU and memory, protecting the contract from accidental
    /// or adversarial resource exhaustion.
    ///
    /// Discriminant: **4** (stable).
    BatchTooLarge = 4,

    /// At least one [`Bet`] in the batch carries a non-positive `amount`
    /// (zero or negative).  Every bet must stake a strictly positive number
    /// of stroops.
    ///
    /// Returning this error before any state mutation ensures the call is
    /// fully atomic: either the entire batch is valid and applied, or nothing
    /// is written.
    ///
    /// Discriminant: **5** (stable).
    ///
    /// [`Bet`]: crate::bets::Bet
    AmountMustBePositive = 5,

    /// At least one [`Bet`] in the batch references `market_id = 0`, which is
    /// the reserved "null" sentinel and is never a valid market identifier.
    /// Callers must use a non-zero `market_id`.
    ///
    /// The `market_id` space for valid markets starts at **1**.  Using zero as
    /// a default/unset sentinel on the client side is a common mistake; this
    /// error surfaces it early before any storage is touched.
    ///
    /// Discriminant: **6** (stable).
    ///
    /// [`Bet`]: crate::bets::Bet
    MarketIdInvalid = 6,
}
