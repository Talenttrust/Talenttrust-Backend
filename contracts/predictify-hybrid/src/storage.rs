use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::Error;

/// TWL for consumed idempotency keys, expressed in ledgers.
///
/// At ~5 s/ledger this gives roughly 24 hours of replay protection.
/// Each temporary entry has an independent lifetime. The stored deadline
/// also enforces expiry if network minimum retention or a rent extension
/// keeps the physical entry alive longer. A key is consumed through its
/// deadline ledger (inclusive), and may be reused in the following ledger.
///
/// If you need a longer window, increase this constant and redeploy.
///
/// ## Compatibility contract
///
/// This constant is part of the public API and is re-exported from
/// `lib.rs`.  Changing it changes the replay-protection window for
/// any future deployment.  It must not be lowered without a migration
/// plan, because that would allow a replay of an already-applied batch.
pub const IDEM_KEY_TTL_LEDGERS: u32 = 17_280; // ~24 h at 5 s/ledger

/// Maximum number of [`Bet`] entries allowed in a single `place_bets` call.
///
/// This bound protects the contract against accidental or adversarial
/// resource exhaustion.  A batch that exceeds this limit is rejected with
/// [`crate::errors::Error::BatchTooLarge`] before any state mutation, so
/// the call is atomic: either the full (valid) batch is applied or nothing
/// is written.
///
/// Callers that need to submit more than `MAX_BATCH_SIZE` bets must split
/// the work into multiple invocations, each with a distinct idempotency key.
///
/// Kept equal to [`crate::bets::MAX_BATCH_SIZE`] and the crate-root
/// `MAX_BATCH_SIZE`; the three names must not drift apart or a batch the
/// contract accepts could be rejected by a caller sizing off another one.
///
/// [`Bet`]: crate::bets::Bet
pub const MAX_BATCH_SIZE: u32 = 100;

/// Lower bound on the *remaining* TTL of a consumed idempotency receipt
/// before [`IDEM_KEY_TTL_LEDGERS`] is (re)applied to it.
///
/// `extend_ttl(threshold, extend_to)` is a no-op when the entry's live TTL
/// is already at or above `threshold`, so the threshold must sit well below
/// the target for the window to be genuinely renewed on each write.
pub const IDEM_KEY_TTL_THRESHOLD_LEDGERS: u32 = 1_000; // ~1.4 h at 5 s/ledger

/// TTL applied to the contract instance when a batch is accepted, in
/// ledgers. The instance is not kept alive by the per-receipt TTLs, so an
/// idle contract would otherwise be archived and reject calls whose
/// receipts are still live.
pub const INSTANCE_TTL_LEDGERS: u32 = 518_400;

/// TTL applied to the contract's own instance/code entry when a batch is
/// accepted, in ledgers. Set above [`IDEM_KEY_TTL_LEDGERS`] so a live
/// receipt never outlives the contract that minted it in normal operation.
pub const CONTRACT_TTL_LEDGERS: u32 = 34_560; // ~48 h at 5 s/ledger

/// Lower bound on the *remaining* TTL of the contract entry before
/// [`CONTRACT_TTL_LEDGERS`] is (re)applied. Must be far below the target so
/// the bump fires only as the entry approaches expiry.
pub const CONTRACT_TTL_THRESHOLD_LEDGERS: u32 = 1_000; // ~1.4 h at 5 s/ledger

/// Storage keys used by the contract.
///
/// `PlaceBetsIdem(user, key)` stores an inclusive ledger deadline in
/// temporary storage once a `place_bets` batch has been accepted. The key binds the
/// token to the submitting address so two different callers may reuse the
/// same 32-byte token independently without conflict.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Idempotency receipt for a `place_bets` call.
    /// Keyed by (caller address, 32-byte token supplied by the caller).
    PlaceBetsIdem(Address, BytesN<32>),
    /// Inclusive cutoff for legacy instance-storage boolean sentinels.
    /// Set once by the first successful nonzero-key submission after upgrade.
    LegacyIdemDeadline,
}

/// Reserve a nonzero token in the same transaction as the batch effects.
///
/// Only the authenticated, validated entry point may call this helper.
/// A host failure or contract error rolls back the reservation and events.
/// Soroban serializes conflicting ledger writes, so two transactions cannot
/// both commit the same live (caller, token) reservation.
///
/// Old boolean sentinels contain no creation ledger. Conservatively reject
/// them until one full window after the first successful new submission.
/// Failed/duplicate calls cannot restart that cutoff. Remove an old sentinel
/// only when its token is successfully reused after the cutoff.
pub(crate) fn consume_idempotency_key(
    env: &Env,
    caller: &Address,
    token: &BytesN<32>,
) -> Result<(), Error> {
    let key = DataKey::PlaceBetsIdem(caller.clone(), token.clone());
    let now = env.ledger().sequence();
    let legacy_deadline: Option<u32> = env.storage().instance().get(&DataKey::LegacyIdemDeadline);

    if env.storage().instance().has(&key) && legacy_deadline.is_none_or(|deadline| now <= deadline)
    {
        return Err(Error::IdempotentBatchAlreadyApplied);
    }
    if let Some(deadline) = env.storage().temporary().get::<_, u32>(&key) {
        if now <= deadline {
            return Err(Error::IdempotentBatchAlreadyApplied);
        }
    }

    // Never silently shorten replay protection or wrap a ledger deadline.
    let deadline = now
        .checked_add(IDEM_KEY_TTL_LEDGERS)
        .ok_or(Error::IdempotencyRetentionUnavailable)?;
    if env.storage().max_ttl() < IDEM_KEY_TTL_LEDGERS {
        return Err(Error::IdempotencyRetentionUnavailable);
    }

    if legacy_deadline.is_none() {
        env.storage()
            .instance()
            .set(&DataKey::LegacyIdemDeadline, &deadline);
    }
    env.storage().instance().remove(&key);
    // Recreate a logically expired entry so its old physical TTL is not reused.
    env.storage().temporary().remove(&key);
    env.storage().temporary().set(&key, &deadline);
    env.storage()
        .temporary()
        .extend_ttl(&key, IDEM_KEY_TTL_LEDGERS, IDEM_KEY_TTL_LEDGERS);
    // Keep the contract live for the window; this does not renew token entries.
    env.storage()
        .instance()
        .extend_ttl(IDEM_KEY_TTL_LEDGERS, IDEM_KEY_TTL_LEDGERS);
    Ok(())
}
