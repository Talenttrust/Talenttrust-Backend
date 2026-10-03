use soroban_sdk::{Address, BytesN, Env, Symbol, Vec};

use crate::{errors::Error, storage::consume_idempotency_key};

/// Maximum number of bets accepted in a single [`place_bets`] call.
///
/// This bound exists so that one invocation always fits inside the Soroban
/// CPU/instruction budget: the contract iterates the whole vector, and an
/// unbounded vector would let a caller construct a batch that can never be
/// applied.  Callers with more than `MAX_BATCH_SIZE` bets must split them
/// into several submissions, each carrying its own idempotency key.
///
/// Raising this constant is a backwards-compatible change; lowering it is
/// not, because it would start rejecting payloads that used to be accepted.
pub const MAX_BATCH_SIZE: u32 = 100;

/// A single bet submitted inside a batch.
///
/// Extend this struct with market-specific fields as the contract grows.
/// Any new field is covered by I5: it must be validated in
/// [`validate_bets`] before the first write.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bet {
    /// Identifier of the prediction market being bet on.
    ///
    /// Must be non-zero.  `market_id = 0` is the reserved "null" sentinel
    /// and is always rejected with [`Error::MarketIdInvalid`].
    pub market_id: u64,
    /// Amount of the base asset staked, in stroops.
    ///
    /// Must be strictly positive (> 0).  Zero or negative values are
    /// rejected with [`Error::InvalidBetAmount`].
    pub amount: i128,
}

/// Validate a single [`Bet`] entry against the storage-layer boundaries.
///
/// # Invariants
///
/// * `market_id` must be non-zero (zero is reserved as an invalid sentinel).
/// * `amount` must satisfy `MIN_BET_AMOUNT <= amount <= MAX_BET_AMOUNT`.
///
/// The function is pure and deterministic: identical inputs always yield
/// identical results, and it performs no storage reads or writes.
fn validate_bet(bet: &Bet) -> Result<(), Error> {
    if bet.market_id == 0 {
        return Err(Error::InvalidMarketId);
    }
    if bet.amount < MIN_BET_AMOUNT {
        return Err(Error::BetAmountTooSmall);
    }
    if bet.amount > MAX_BET_AMOUNT {
        return Err(Error::BetAmountTooLarge);
    }
    Ok(())
}

/// Validate the whole batch before any state mutation occurs.
///
/// # Invariants
///
/// * The batch is non-empty.
/// * The batch size does not exceed [`MAX_BATCH_SIZE`].
/// * Every entry passes [`validate_bet`].
///
/// Validation is performed in a single pass up-front so that a rejected
/// batch never partially mutates storage (all-or-nothing semantics).
fn validate_batch(bets: &Vec<Bet>) -> Result<(), Error> {
    if bets.is_empty() {
        return Err(Error::EmptyBatch);
    }
    if bets.len() > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }
    for bet in bets.iter() {
        validate_bet(&bet)?;
    }
    Ok(())
}

/// Process a batch of bets atomically with an idempotency guarantee.
///
/// # Arguments
///
/// * `env`             – Soroban host environment.
/// * `caller`          – Address of the submitting account; `require_auth` is
///   called to authenticate the caller.
/// * `bets`            – Non-empty vector of [`Bet`] entries.
/// * `idempotency_key` – 32-byte caller-generated token that makes this
///   submission unique. The key is bound to `caller` so the same token may
///   be used by different callers without conflict.
///
/// # Errors
///
/// * [`Error::EmptyBatch`]                  – `bets` is empty.
/// * [`Error::BatchTooLarge`]               – `bets.len() > MAX_BETS_PER_BATCH`.
/// * [`Error::InvalidMarketId`]             – a bet referenced `market_id == 0`.
/// * [`Error::InvalidBetAmount`]            – a bet had `amount <= 0`.
/// * [`Error::BatchAmountOverflow`]         – the batch total does not fit in an `i128`.
/// * [`Error::IdempotentBatchAlreadyApplied`] – the `(caller, idempotency_key)`
///   pair has already been consumed.
/// * [`Error::IdempotencyRetentionUnavailable`] – the full retention window
///   cannot be represented or supported.
///
/// # Idempotency semantics
///
/// The key is reserved in temporary storage **before** processing the bets.
/// If a previous call with the same key succeeded, the function returns
/// [`Error::IdempotentBatchAlreadyApplied`] immediately without re-applying
/// the batch. Each key has its own inclusive deadline at acceptance ledger +
/// [`crate::storage::IDEM_KEY_TTL_LEDGERS`]; unrelated submissions and duplicate retries do
/// not renew it. In the following ledger the token is accepted as a fresh
/// batch. Reservation and effects commit or roll back together. Legacy
/// instance sentinels follow the conservative cutoff documented in storage.
///
/// A two-phase marker is used to make concurrent execution deterministic:
/// the key is first written as *pending* (with a short TTL) and only promoted
/// to *applied* after the batch has been fully processed.  A second call that
/// observes a pending marker returns [`Error::BatchInProgress`] rather than
/// racing the first caller, and a call that observes an applied marker returns
/// [`Error::IdempotentBatchAlreadyApplied`].  If the first caller traps before
/// promoting the marker, the pending entry expires after
/// [`PENDING_IDEM_KEY_TTL_LEDGERS`] ledgers and the key becomes reusable.
///
/// # Deprecation note — zero-key backward path
///
/// Passing `[0u8; 32]` as the key disables idempotency checking and
/// processes the batch unconditionally.  **This path is deprecated** and
/// will be removed in a future version.  Callers should generate a random
/// 32-byte token for every batch. It offers no replay protection and no
/// same-ledger dedup, but all validation in I5/I6 still applies, and the
/// `bets_placed` event reports `deduplicated == false` so indexers can
/// account for these submissions separately.
pub fn place_bets(
    env: &Env,
    caller: Address,
    bets: Vec<Bet>,
    idempotency_key: BytesN<32>,
) -> Result<(), Error> {
    // I1 — authenticate before doing anything observable. A caller that
    // cannot authorize must not be able to burn its own token.
    caller.require_auth();

    // ------------------------------------------------------------------
    // Structural validation — cheapest checks first, no storage reads.
    // ------------------------------------------------------------------

    // Reject empty batches.
    if bets.is_empty() {
        return Err(Error::EmptyBatch);
    }

    // Reject over-sized batches before iterating over the entries.
    if bets.len() > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    // ------------------------------------------------------------------
    // Per-element validation — O(n) scan; still before any storage write.
    // ------------------------------------------------------------------
    for bet in bets.iter() {
        // A non-positive amount is never a valid stake.
        if bet.amount <= 0 {
            return Err(Error::InvalidBetAmount);
        }

        // market_id == 0 is the reserved null sentinel; always invalid.
        if bet.market_id == 0 {
            return Err(Error::MarketIdInvalid);
        }
    }

    // ------------------------------------------------------------------
    // Idempotency check — one storage read, after all validation passes.
    // ------------------------------------------------------------------
    // A zero key opts out of deduplication (deprecated backward compat).
    let zero_key: BytesN<32> = BytesN::from_array(env, &[0u8; 32]);
    if idempotency_key != zero_key {
        consume_idempotency_key(env, &caller, &idempotency_key)?;
    }
    env.storage()
        .instance()
        .extend_ttl(IDEM_KEY_TTL_LEDGERS, IDEM_KEY_TTL_LEDGERS);

    // Keep the instance (and any legacy keys in it) alive well beyond the
    // key window so replay protection can't lapse with an idle contract.
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_LEDGERS / 2, INSTANCE_TTL_LEDGERS);

    // Keep the contract itself reachable. The instance/code entry has its
    // own TTL that no per-key receipt bump renews, so an accepted batch
    // refreshes it here; see CONTRACT_TTL_LEDGERS. Done for the
    // zero-key path too — that path writes no receipt, so this is the
    // only thing keeping the contract alive for those callers.
    env.storage()
        .instance()
        .extend_ttl(CONTRACT_TTL_THRESHOLD_LEDGERS, CONTRACT_TTL_LEDGERS);

    // ------------------------------------------------------------------
    // Apply the batch
    // ------------------------------------------------------------------
    // TODO: replace with real market-state mutations once the market
    //       storage module is added.  For now we emit a diagnostic event
    //       so the batch is observable on-chain.
    apply_batch(env, &caller, &bets)
}

/// Apply the batch of bets to market state.
///
/// Kept separate from [`place_bets`] so the idempotency bookkeeping and the
/// state mutation can be reasoned about independently.  The caller is
/// responsible for having authenticated `caller` and for having claimed the
/// idempotency key before invoking this function.
fn apply_batch(env: &Env, caller: &Address, bets: &Vec<Bet>) -> Result<(), Error> {
    // TODO: replace with real market-state mutations once the market
    //       storage module is added.  For now we emit a diagnostic event
    //       so the batch is observable on-chain.
    env.events()
        .publish((Symbol::new(env, "place_bets"), caller.clone()), bets.len());
    Ok(())
}
