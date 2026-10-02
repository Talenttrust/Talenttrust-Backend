use soroban_sdk::contracterror;

/// Contract-level error codes returned as `Err(Error::*)`.
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
/// ## Why there are more variants than a clean taxonomy would have
///
/// Discriminants 1–5 are the released, client-visible vocabulary. The
/// variants below them (6–15) are **compatibility aliases** accumulated as
/// several long-lived branches merged with different names for the same
/// conditions (`InvalidAmount` vs `AmountMustBePositive` vs
/// `InvalidBetAmount`, `InvalidMarketId` vs `MarketIdInvalid`,
/// `AmountOverflow` vs `BatchAmountOverflow`). They cannot be removed — the
/// compatibility contract forbids reclaiming a slot — and existing callers
/// and tests reference each name, so they stay. New code should prefer the
/// 1–5 vocabulary; the aliases exist so no previously released name breaks.
///
/// Currently reserved discriminants: 1–15.
/// The next available discriminant is: **16**.
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
    // Discriminants 1–5: released vocabulary — frozen, must not be renumbered.
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

    /// At least one [`Bet`] carried an amount outside the accepted range
    /// (non-positive, or otherwise invalid). The batch is rejected before any
    /// state is written.
    ///
    /// Discriminant: **3** (stable).
    ///
    /// [`Bet`]: crate::bets::Bet
    InvalidAmount = 3,

    /// The `bets` vector exceeds [`crate::storage::MAX_BATCH_SIZE`]; split the
    /// submission into smaller chunks, each with a fresh idempotency key.
    ///
    /// Discriminant: **4** (stable).
    BatchTooLarge = 4,

    /// The sum of the batch amounts does not fit in an `i128`. No state was
    /// written.
    ///
    /// Discriminant: **5** (stable).
    AmountOverflow = 5,

    // ──────────────────────────────────────────────────────────────────────
    // Discriminants 6–15: compatibility aliases. Append-only; never reuse.
    // ──────────────────────────────────────────────────────────────────────
    /// Alias for [`Error::InvalidAmount`] used by the batch validator: at
    /// least one bet had `amount <= 0`.
    ///
    /// Discriminant: **6** (stable).
    AmountMustBePositive = 6,

    /// Alias for [`Error::AmountOverflow`] used by the batch validator when
    /// the summed stake overflows `i128`.
    ///
    /// Discriminant: **7** (stable).
    BatchAmountOverflow = 7,

    /// Alias for [`Error::InvalidAmount`]: a single bet's `amount` exceeded
    /// the accepted maximum.
    ///
    /// Discriminant: **8** (stable).
    BetAmountTooLarge = 8,

    /// Alias for [`Error::InvalidAmount`]: a single bet's `amount` fell below
    /// the accepted minimum.
    ///
    /// Discriminant: **9** (stable).
    BetAmountTooSmall = 9,

    /// Alias for [`Error::IdempotentBatchAlreadyApplied`] when a consumed key
    /// is replayed with a *different* batch body.
    ///
    /// Discriminant: **10** (stable).
    IdempotencyKeyReusedWithDifferentBatch = 10,

    /// The ledger range or network maximum TTL cannot preserve the full
    /// replay-protection window. No token or batch effects were committed.
    ///
    /// Discriminant: **11** (stable).
    IdempotencyRetentionUnavailable = 11,

    /// Alias for [`Error::InvalidAmount`] used by the invalidation path.
    ///
    /// Discriminant: **12** (stable).
    InvalidBetAmount = 12,

    /// A legacy/consumed idempotency marker was found in an unrecognised
    /// state. No state was written.
    ///
    /// Discriminant: **13** (stable).
    InvalidIdempotencyState = 13,

    /// Alias for [`Error::MarketIdInvalid`]: a bet referenced `market_id == 0`.
    ///
    /// Discriminant: **14** (stable).
    InvalidMarketId = 14,

    /// At least one [`Bet`] referenced `market_id = 0`, the reserved "null"
    /// sentinel. The valid `market_id` space starts at 1.
    ///
    /// Discriminant: **15** (stable).
    ///
    /// [`Bet`]: crate::bets::Bet
    MarketIdInvalid = 15,
}
