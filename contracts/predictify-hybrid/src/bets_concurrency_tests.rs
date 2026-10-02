//! Tests for concurrent and repeated execution of `place_bets`.
//!
//! [`crate::bets_invariants_tests`] pins per-call validation and state
//! invariants; [`crate::batch_operations_tests`] walks the idempotency
//! key lifecycle. This module covers what happens when *two* submissions
//! race for the same token: which one wins, what the loser observes, and
//! whether the winner's recorded state survives intact.
//!
//! The Soroban test host executes one transaction at a time, so a true
//! parallel race cannot be reproduced here. What the host *does* model
//! faithfully is the sequentialized outcome of one — the loser arriving
//! after the winner, which is exactly the case where idempotency has to
//! hold. The same-ledger half of the race is resolved by the ledger's
//! transaction-set rules rather than by contract code; `bets` documents
//! what a client observes there.
//!
//! Run with:
//! ```text
//! cargo test -p predictify-hybrid bets_concurrency_tests -- --nocapture
//! ```

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, BytesN, Env, Symbol, TryFromVal, Vec,
};

use crate::{
    bets::batch_digest,
    storage::{IDEM_KEY_TTL_LEDGERS, RECEIPT_EXTEND_THRESHOLD_LEDGERS},
    BatchReceipt, Bet, DataKey, Error, PredictifyHybrid, PredictifyHybridClient,
};

// ── helpers ──────────────────────────────────────────────────────────────────

fn register(env: &Env) -> (Address, PredictifyHybridClient) {
    let contract_id = env.register(PredictifyHybrid, ());
    let client = PredictifyHybridClient::new(env, &contract_id);
    (contract_id, client)
}

fn caller(env: &Env) -> Address {
    Address::generate(env)
}

fn key(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn zero_key(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

fn bet(market_id: u64, amount: i128) -> Bet {
    Bet { market_id, amount }
}

fn batch_of(env: &Env, bets: &[Bet]) -> Vec<Bet> {
    let mut v = Vec::new(env);
    for b in bets {
        v.push_back(b.clone());
    }
    v
}

fn receipt(
    env: &Env,
    contract: &Address,
    user: &Address,
    idem: &BytesN<32>,
) -> Option<BatchReceipt> {
    env.as_contract(contract, || {
        env.storage()
            .temporary()
            .get(&DataKey::PlaceBetsIdem(user.clone(), idem.clone()))
    })
}

fn digest_of(
    env: &Env,
    contract: &Address,
    user: &Address,
    idem: &BytesN<32>,
) -> Option<BytesN<32>> {
    env.as_contract(contract, || {
        env.storage()
            .temporary()
            .get(&DataKey::PlaceBetsDigest(user.clone(), idem.clone()))
    })
}

/// Count `bets_placed` events published in the current test run.
///
/// Anything that calls this must run outside `as_contract`, whose test
/// frame rolls the event buffer back on exit.
fn bets_placed_count(env: &Env) -> u32 {
    let wanted = Symbol::new(env, "bets_placed");
    env.events()
        .all()
        .iter()
        .filter(|(_, topics, _)| {
            topics
                .get(0)
                .and_then(|t| Symbol::try_from_val(env, t).ok())
                .map_or(false, |s| s == wanted)
        })
        .count() as u32
}

/// Advance the ledger by `ledgers`.
fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| li.sequence_number += ledgers);
}

// ── module ───────────────────────────────────────────────────────────────────

mod bets_concurrency_tests {
    use super::*;

    // ── I8: distinguishing a duplicate from a collision ──────────────────────

    /// Two submissions racing for the same token, with the same batch: the
    /// second is an honest duplicate and says so.
    #[test]
    fn racing_same_batch_is_reported_as_duplicate() {
        let env = Env::default();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x01);
        let batch = batch_of(&env, &[bet(1, 100), bet(2, 50)]);

        env.mock_all_auths();

        // Winner.
        client.place_bets(&user, &batch, &idem);

        // Loser, serialized. Identical payload, so the caller is told its
        // batch is already in and it can stop worrying.
        assert_eq!(
            client.try_place_bets(&user, &batch, &idem),
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
        );
    }

    /// Two submissions racing for the same token with *different* batches:
    /// the loser must be told its batch was never applied, so it does not
    /// walk away believing a bet went through. This is the case a
    /// key-only check cannot distinguish from a duplicate.
    #[test]
    fn racing_different_batch_is_reported_as_collision() {
        let env = Env::default();
        let (id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x02);

        env.mock_all_auths();

        let winner = batch_of(&env, &[bet(1, 100)]);
        let loser = batch_of(&env, &[bet(7, 900)]);

        client.place_bets(&user, &winner, &idem);
        let after_win = receipt(&env, &id, &user, &idem).expect("receipt must exist");

        assert_eq!(
            client.try_place_bets(&user, &loser, &idem),
            Err(Ok(Error::IdempotencyKeyReusedWithDifferentBatch)),
            "a losing racer must not be told its batch was applied",
        );

        // The collision is reported without disturbing the winner's record:
        // the stored receipt still describes the batch that actually won.
        assert_eq!(
            receipt(&env, &id, &user, &idem),
            Some(after_win),
            "a rejected racer must not overwrite the winning receipt",
        );
        assert_eq!(
            digest_of(&env, &id, &user, &idem),
            Some(batch_digest(&env, &winner)),
            "the stored fingerprint must still describe the winning batch",
        );
    }

    /// Only the fields that decide *what* was submitted may separate a
    /// duplicate from a collision. Every one of them, on its own, must.
    #[test]
    fn any_payload_difference_is_a_collision() {
        let env = Env::default();
        let (id, client) = register(&env);
        let user = caller(&env);

        env.mock_all_auths();

        let base = batch_of(&env, &[bet(1, 100), bet(2, 200)]);
        let variants = [
            // Different market.
            batch_of(&env, &[bet(9, 100), bet(2, 200)]),
            // Different amount.
            batch_of(&env, &[bet(1, 101), bet(2, 200)]),
            // Same bets, different order.
            batch_of(&env, &[bet(2, 200), bet(1, 100)]),
            // A prefix of the original batch.
            batch_of(&env, &[bet(1, 100)]),
            // The original batch plus one more.
            batch_of(&env, &[bet(1, 100), bet(2, 200), bet(3, 300)]),
        ];

        for (i, variant) in variants.iter().enumerate() {
            let idem = key(&env, 0x10 + i as u8);
            client.place_bets(&user, &base, &idem);

            assert_eq!(
                client.try_place_bets(&user, variant, &idem),
                Err(Ok(Error::IdempotencyKeyReusedWithDifferentBatch)),
                "variant {i} must not be mistaken for the batch already applied",
            );
            assert_eq!(
                digest_of(&env, &id, &user, &idem),
                Some(batch_digest(&env, &base)),
                "variant {i} must not have altered the stored fingerprint",
            );
        }
    }

    /// An identical batch retried any number of times is deterministic: the
    /// same error, and no drift in recorded state.
    #[test]
    fn repeated_identical_retry_is_deterministic() {
        let env = Env::default();
        let (id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x03);
        let batch = batch_of(&env, &[bet(3, 700)]);

        env.mock_all_auths();
        client.place_bets(&user, &batch, &idem);
        let after_first = receipt(&env, &id, &user, &idem).expect("receipt must exist");

        for _ in 0..5 {
            assert_eq!(
                client.try_place_bets(&user, &batch, &idem),
                Err(Ok(Error::IdempotentBatchAlreadyApplied)),
            );
        }

        assert_eq!(receipt(&env, &id, &user, &idem), Some(after_first));
    }

    // ── scoping: keys are per caller ───────────────────────────────────────

    /// Two callers racing for the *same* token are not in conflict: the
    /// receipt is keyed per `(caller, key)`, so each is a first submission
    /// from its own principal. Neither can see or consume the other's
    /// receipt.
    #[test]
    fn same_token_from_different_callers_does_not_collide() {
        let env = Env::default();
        let (id, client) = register(&env);
        let alice = caller(&env);
        let bob = caller(&env);
        let idem = key(&env, 0x04);

        // Deliberately different batches: if the fingerprint leaked across
        // callers this would surface as a collision.
        let alice_bets = batch_of(&env, &[bet(1, 100)]);
        let bob_bets = batch_of(&env, &[bet(2, 555)]);

        env.mock_all_auths();
        client.place_bets(&alice, &alice_bets, &idem);
        client.place_bets(&bob, &bob_bets, &idem);

        // Each caller still sees exactly its own result as a duplicate.
        assert_eq!(
            client.try_place_bets(&alice, &alice_bets, &idem),
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
        );
        assert_eq!(
            client.try_place_bets(&bob, &bob_bets, &idem),
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
        );

        assert_eq!(
            digest_of(&env, &id, &alice, &idem),
            Some(batch_digest(&env, &alice_bets)),
        );
        assert_eq!(
            digest_of(&env, &id, &bob, &idem),
            Some(batch_digest(&env, &bob_bets)),
        );
    }

    // ── rejections leave no trace ──────────────────────────────────────────

    /// A rejected batch must not consume the token, otherwise a caller that
    /// fixed a typo would be permanently locked out of its own retry.
    #[test]
    fn rejected_batch_leaves_token_usable() {
        let env = Env::default();
        let (id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x05);

        env.mock_all_auths();

        // A zero amount is refused before the claim.
        assert_eq!(
            client.try_place_bets(&user, &batch_of(&env, &[bet(1, 0)]), &idem),
            Err(Ok(Error::InvalidBetAmount)),
        );
        assert!(receipt(&env, &id, &user, &idem).is_none());
        assert!(digest_of(&env, &id, &user, &idem).is_none());

        // The corrected batch takes the token cleanly.
        client.place_bets(&user, &batch_of(&env, &[bet(1, 100)]), &idem);
        assert!(receipt(&env, &id, &user, &idem).is_some());
    }

    /// Validation is decided before the idempotency check, so a batch that
    /// is both invalid and under a spent token reports the payload problem.
    /// Ordering has to be fixed, or a caller cannot tell what to fix.
    #[test]
    fn validation_precedes_the_idempotency_check() {
        let env = Env::default();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x06);
        let batch = batch_of(&env, &[bet(1, 100)]);

        env.mock_all_auths();
        client.place_bets(&user, &batch, &idem);

        // Token spent, payload invalid: the payload is what the caller can
        // act on, so it is what gets reported.
        assert_eq!(
            client.try_place_bets(&user, &batch_of(&env, &[bet(0, 100)]), &idem),
            Err(Ok(Error::InvalidMarketId)),
        );
        assert_eq!(
            client.try_place_bets(&user, &batch_of(&env, &[bet(1, -1)]), &idem),
            Err(Ok(Error::InvalidBetAmount)),
        );
    }

    /// A rejected race publishes nothing. Events are reverted along with
    /// everything else on the error path, so an indexer cannot mistake a
    /// refused submission for an applied one.
    #[test]
    fn rejected_race_publishes_no_event() {
        let env = Env::default();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x07);
        let batch = batch_of(&env, &[bet(1, 100)]);

        env.mock_all_auths();
        client.place_bets(&user, &batch, &idem);
        assert_eq!(
            bets_placed_count(&env),
            1,
            "the accepted batch must publish bets_placed",
        );

        // The rejected racer must not add anything.
        let _ = client.try_place_bets(&user, &batch_of(&env, &[bet(4, 400)]), &idem);

        assert_eq!(
            bets_placed_count(&env),
            1,
            "only the accepted batch may be published",
        );
    }

    // ── timing ─────────────────────────────────────────────────────────────

    /// The replay window is the documented one, whatever the network's
    /// temporary-entry floor is.
    ///
    /// A receipt is written once and never re-extended, so the only TTL it
    /// ever has is the one given at write time. With the threshold that used
    /// to guard that write, a network floor above the threshold would skip
    /// the extension entirely and the receipt would die after
    /// `min_temp_entry_ttl` instead — silently shortening replay
    /// protection to a fraction of what the documentation promises.
    #[test]
    fn replay_window_holds_with_a_high_temporary_entry_floor() {
        let env = Env::default();

        // A floor above the old 1_000-ledger threshold, still below the
        // target window: the extension must still fire.
        let floor = 5_000;
        env.ledger().with_mut(|li| li.min_temp_entry_ttl = floor);
        assert!(floor > 1_000, "the floor must exceed the retired threshold");

        // Keep the *contract instance* alive across the window. Its initial
        // persistent TTL is otherwise well below `IDEM_KEY_TTL_LEDGERS`, so
        // the instance would be archived mid-test and the later call would
        // fail for an unrelated reason. A low floor lets the contract's own
        // instance/code bump take effect, which is the behaviour under test
        // elsewhere.
        env.ledger()
            .with_mut(|li| li.min_persistent_entry_ttl = 500);

        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x08);
        let batch = batch_of(&env, &[bet(1, 100)]);

        env.mock_all_auths();
        client.place_bets(&user, &batch, &idem);

        // Still protected near the end of the documented window, not just
        // up to the network floor. The assertions stay clear of the exact
        // expiry ledger so they do not encode the host's tie-breaking rule.
        advance(&env, IDEM_KEY_TTL_LEDGERS - 2);
        assert_eq!(
            client.try_place_bets(&user, &batch, &idem),
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
            "replay protection must last the full documented window",
        );

        // Past it, the receipt is gone and the token is free again.
        advance(&env, 4);
        client.place_bets(&user, &batch, &idem);
    }

    /// The threshold constant must keep tracking the target window. If it
    /// drifts below the target, a fresh receipt can again stop short of
    /// `IDEM_KEY_TTL_LEDGERS`.
    #[test]
    fn receipt_extend_threshold_tracks_the_target_window() {
        assert_eq!(
            RECEIPT_EXTEND_THRESHOLD_LEDGERS, IDEM_KEY_TTL_LEDGERS,
            "the receipt must always be renewed to the full window",
        );
    }

    // ── migration ──────────────────────────────────────────────────────────

    /// A receipt written before fingerprints existed has no companion
    /// digest. A replay must still be recognized as a duplicate rather than
    /// reported as a collision, because the contract cannot prove the
    /// batches differ. Claiming a conflict it cannot verify would be worse
    /// than the ambiguity it papers over.
    #[test]
    fn legacy_receipt_without_a_digest_reads_as_a_duplicate() {
        let env = Env::default();
        let (id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x09);

        env.mock_all_auths();

        // Reproduce pre-upgrade state: a receipt, and nothing else.
        env.as_contract(&id, || {
            env.storage().temporary().set(
                &DataKey::PlaceBetsIdem(user.clone(), idem.clone()),
                &BatchReceipt {
                    bet_count: 1,
                    total_amount: 100,
                    applied_at_ledger: 1,
                },
            );
        });
        assert!(digest_of(&env, &id, &user, &idem).is_none());

        // Same batch and a different batch both read as duplicates, and
        // neither mutates the legacy receipt.
        assert_eq!(
            client.try_place_bets(&user, &batch_of(&env, &[bet(1, 100)]), &idem),
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
        );
        assert_eq!(
            client.try_place_bets(&user, &batch_of(&env, &[bet(8, 800)]), &idem),
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
        );
        assert!(receipt(&env, &id, &user, &idem).is_some());
        assert!(digest_of(&env, &id, &user, &idem).is_none());
    }

    // ── the deprecated zero key ────────────────────────────────────────────

    /// The zero key opts out of idempotency, so it opts out of collision
    /// detection too. It must not grow a fingerprint, and repeated calls
    /// keep applying — the documented cost of that deprecated path.
    #[test]
    fn zero_key_still_applies_every_time_and_records_nothing() {
        let env = Env::default();
        let (id, client) = register(&env);
        let user = caller(&env);
        let zero = zero_key(&env);

        env.mock_all_auths();
        client.place_bets(&user, &batch_of(&env, &[bet(1, 100)]), &zero);
        client.place_bets(&user, &batch_of(&env, &[bet(1, 100)]), &zero);
        // Even a differing batch is accepted on this path.
        client.place_bets(&user, &batch_of(&env, &[bet(2, 200)]), &zero);

        assert!(
            receipt(&env, &id, &user, &zero).is_none(),
            "the zero key must not create a receipt",
        );
        assert!(
            digest_of(&env, &id, &user, &zero).is_none(),
            "the zero key must not create a fingerprint",
        );
    }

    // ── the fingerprint itself ─────────────────────────────────────────────

    /// The fingerprint is a stable function of the batch: same input, same
    /// digest. Nothing in it depends on the ledger, the caller, or the
    /// token, so it means the same thing everywhere it is written.
    #[test]
    fn fingerprint_depends_only_on_the_batch() {
        let env = Env::default();
        let batch = batch_of(&env, &[bet(1, 100), bet(2, 200)]);

        let first = batch_digest(&env, &batch);
        assert_eq!(
            first,
            batch_digest(&env, &batch_of(&env, &[bet(1, 100), bet(2, 200)])),
            "same batch, same digest",
        );

        // Nothing in the fingerprint is derived from the ledger, so moving
        // the ledger cannot change what a stored digest means.
        advance(&env, 500);
        assert_eq!(batch_digest(&env, &batch), first);

        // Nor from any field outside the batch. Every one of these changes
        // it, which is what makes it usable to tell batches apart.
        assert_ne!(batch_digest(&env, &batch_of(&env, &[bet(1, 100)])), first);
        assert_ne!(
            batch_digest(&env, &batch_of(&env, &[bet(1, 101), bet(2, 200)])),
            first,
        );
    }
}
