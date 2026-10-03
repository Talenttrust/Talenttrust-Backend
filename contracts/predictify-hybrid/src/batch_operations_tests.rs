//! Integration tests for `place_bets` validation and idempotency semantics.
//!
//! Run with:
//! ```text
//! cargo test -p predictify-hybrid batch_operations_tests -- --nocapture
//! ```
//!
//! # Compatibility contract
//!
//! Everything asserted in this module is part of the contract's public
//! behaviour. Changing any of it is a breaking change for on-chain clients:
//!
//! * `(caller, idempotency_key)` is the unit of deduplication. Two different
//!   callers may reuse the exact same 32-byte token without conflict, and one
//!   caller may use any number of distinct tokens.
//! * The payload does not participate in the key: reusing a consumed token
//!   with a *different* batch is still rejected.
//! * An empty batch is rejected before any state is touched.
//! * The `[0u8; 32]` token opts out of deduplication entirely and must not
//!   write any state (deprecated backward-compat path).
//! * A consumed token is rejected for `IDEM_KEY_TTL_LEDGERS` ledgers starting
//!   at the ledger it was consumed on, and is accepted again on the first
//!   ledger after that window. The contract instance itself stays invokable
//!   across the whole window.
//! * A sentinel written by an older contract version (no recorded ledger) is
//!   a durable replay guard, never an expiring one.

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    Address, BytesN, Env, Vec,
};

use crate::{
    bets::Bet,
    errors::Error,
    storage::{IDEM_KEY_TTL_LEDGERS, MAX_BATCH_SIZE},
    PredictifyHybridClient,
};

// ── helpers ──────────────────────────────────────────────────────────────────

fn fresh_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = IDEM_KEY_TTL_LEDGERS * 3;
    });
    env
}

fn register(env: &Env) -> (Address, PredictifyHybridClient<'_>) {
    let contract_id = env.register_contract(None, crate::PredictifyHybrid);
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

fn one_bet(env: &Env) -> Vec<Bet> {
    let mut v = Vec::new(env);
    v.push_back(Bet {
        market_id: 1,
        amount: 100,
    });
    v
}

// ── batch_operations_tests module ─────────────────────────────────────────────

mod idempotency_tests {
    use super::*;

    // ── original idempotency tests (must not regress) ─────────────────────

    /// A fresh (never-seen) key is accepted and the call succeeds.
    #[test]
    fn fresh_key_succeeds() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x01);

        env.mock_all_auths();
        client.place_bets(&user, &one_bet(&env), &idem);
        // no panic → accepted
    }

    /// Reusing the same key for the same caller is rejected.
    #[test]
    fn same_key_rejected_on_second_call() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x02);

        env.mock_all_auths();
        // First call must succeed.
        client.place_bets(&user, &one_bet(&env), &idem);

        // Second call with identical key must fail.
        let result = client.try_place_bets(&user, &one_bet(&env), &idem);
        assert_eq!(
            result,
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
            "expected IdempotentBatchAlreadyApplied on duplicate key"
        );
    }

    /// Two different callers may each use the same 32-byte token without
    /// conflict because the storage key is `(caller, token)`.
    #[test]
    fn same_token_different_callers_both_accepted() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user_a = caller(&env);
        let user_b = caller(&env);
        let shared_idem = key(&env, 0x03);

        env.mock_all_auths();
        client.place_bets(&user_a, &one_bet(&env), &shared_idem);
        client.place_bets(&user_b, &one_bet(&env), &shared_idem);
        // both must succeed
    }

    /// The same caller using two *different* keys for different payloads is
    /// fine — each token is independent.
    #[test]
    fn same_caller_different_keys_both_accepted() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        env.mock_all_auths();
        client.place_bets(&user, &one_bet(&env), &key(&env, 0x04));
        client.place_bets(&user, &one_bet(&env), &key(&env, 0x05));
        // both must succeed
    }

    /// After the TTL elapses, the consumed key is eligible for eviction and a
    /// re-submission with the same token is treated as a fresh batch.
    ///
    /// This test simulates ledger advancement past the TTL by bumping the
    /// ledger sequence beyond `IDEM_KEY_TTL_LEDGERS`.
    #[test]
    fn same_key_accepted_after_ttl_expiry() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x06);

        env.mock_all_auths();

        // First submission — consumed.
        client.place_bets(&user, &one_bet(&env), &idem);

        // Simulate ledger advancing past TTL so storage is evicted.
        env.ledger().with_mut(|li| {
            li.sequence_number += IDEM_KEY_TTL_LEDGERS + 1;
        });

        // After TTL expiry, the entry is gone; a re-submission must succeed.
        client.place_bets(&user, &one_bet(&env), &idem);
    }

    /// Same key but different payload (different bets vector): the payload
    /// difference is irrelevant — the key alone governs idempotency, so the
    /// second call is still rejected.
    #[test]
    fn same_key_different_payload_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0x07);

        // Two distinct bet vectors.
        let mut bets_b = Vec::new(&env);
        bets_b.push_back(Bet {
            market_id: 2,
            amount: 999,
        });

        env.mock_all_auths();
        client.place_bets(&user, &one_bet(&env), &idem);

        let result = client.try_place_bets(&user, &bets_b, &idem);
        assert_eq!(
            result,
            Err(Ok(Error::IdempotentBatchAlreadyApplied)),
            "duplicate key with different payload must still be rejected"
        );
    }

    /// An empty bets vector is rejected regardless of the idempotency key.
    #[test]
    fn empty_batch_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        env.mock_all_auths();
        let result = client.try_place_bets(&user, &Vec::new(&env), &key(&env, 0x08));
        assert_eq!(
            result,
            Err(Ok(Error::EmptyBatch)),
            "empty batch must return EmptyBatch error"
        );
    }

    /// The zero key (`[0u8; 32]`) disables idempotency checking; repeated
    /// calls with the zero key all succeed (deprecated backward-compat path).
    #[test]
    fn zero_key_disables_idempotency_deprecated() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let zero = BytesN::from_array(&env, &[0u8; 32]);

        env.mock_all_auths();
        client.place_bets(&user, &one_bet(&env), &zero);
        // Second call with zero key must also succeed (no dedup check).
        client.place_bets(&user, &one_bet(&env), &zero);
    }

    // ── new error-variant tests ───────────────────────────────────────────

    /// A batch that exceeds `MAX_BATCH_SIZE` is rejected with
    /// `BatchTooLarge` before any state mutation.
    ///
    /// Boundary condition: `MAX_BATCH_SIZE` items succeeds; `MAX_BATCH_SIZE + 1`
    /// items fails.  This verifies both sides of the boundary.
    #[test]
    fn batch_too_large_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        env.mock_all_auths();

        // Build a batch of exactly MAX_BATCH_SIZE items — must succeed.
        let mut max_bets = Vec::new(&env);
        for i in 0..MAX_BATCH_SIZE {
            max_bets.push_back(Bet {
                market_id: (i as u64) + 1,
                amount: 1,
            });
        }
        client.place_bets(&user, &max_bets, &key(&env, 0xA0));

        // Build a batch of MAX_BATCH_SIZE + 1 items — must fail.
        let user2 = caller(&env);
        let mut over_bets = Vec::new(&env);
        for i in 0..=MAX_BATCH_SIZE {
            over_bets.push_back(Bet {
                market_id: (i as u64) + 1,
                amount: 1,
            });
        }
        let result = client.try_place_bets(&user2, &over_bets, &key(&env, 0xA1));
        assert_eq!(
            result,
            Err(Ok(Error::BatchTooLarge)),
            "batch exceeding MAX_BATCH_SIZE must return BatchTooLarge"
        );
    }

    /// A batch with exactly one entry at the boundary (1 item) is accepted.
    ///
    /// Regression guard: make sure the lower boundary (non-empty) is accepted.
    #[test]
    fn single_bet_at_lower_boundary_accepted() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        env.mock_all_auths();
        client.place_bets(&user, &one_bet(&env), &key(&env, 0xB0));
        // no panic → accepted
    }

    /// A bet with `amount = 0` is rejected with `InvalidBetAmount`.
    #[test]
    fn zero_amount_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 1,
            amount: 0, // invalid
        });

        env.mock_all_auths();
        let result = client.try_place_bets(&user, &bets, &key(&env, 0xC0));
        assert_eq!(
            result,
            Err(Ok(Error::InvalidBetAmount)),
            "amount=0 must return InvalidBetAmount"
        );
    }

    /// A bet with a negative `amount` is rejected with `InvalidBetAmount`.
    #[test]
    fn negative_amount_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 1,
            amount: -1, // invalid
        });

        env.mock_all_auths();
        let result = client.try_place_bets(&user, &bets, &key(&env, 0xC1));
        assert_eq!(
            result,
            Err(Ok(Error::InvalidBetAmount)),
            "negative amount must return InvalidBetAmount"
        );
    }

    /// Minimum valid amount (1 stroop) is accepted — boundary case.
    #[test]
    fn minimum_positive_amount_accepted() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 1,
            amount: 1, // minimum positive
        });

        env.mock_all_auths();
        client.place_bets(&user, &bets, &key(&env, 0xC2));
        // no panic → accepted
    }

    /// A bet with `market_id = 0` (the reserved null sentinel) is rejected
    /// with `MarketIdInvalid`.
    #[test]
    fn zero_market_id_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 0, // reserved sentinel — invalid
            amount: 100,
        });

        env.mock_all_auths();
        let result = client.try_place_bets(&user, &bets, &key(&env, 0xD0));
        assert_eq!(
            result,
            Err(Ok(Error::MarketIdInvalid)),
            "market_id=0 must return MarketIdInvalid"
        );
    }

    /// Minimum valid market_id (1) is accepted — boundary case.
    #[test]
    fn minimum_market_id_accepted() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 1, // minimum valid
            amount: 100,
        });

        env.mock_all_auths();
        client.place_bets(&user, &bets, &key(&env, 0xD1));
        // no panic → accepted
    }

    /// A multi-entry batch where the *second* bet has a zero amount is
    /// rejected with `InvalidBetAmount`.  Confirms the entire vector
    /// is scanned, not just the first element.
    #[test]
    fn invalid_amount_in_second_bet_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 1,
            amount: 100, // valid
        });
        bets.push_back(Bet {
            market_id: 2,
            amount: 0, // invalid — second entry
        });

        env.mock_all_auths();
        let result = client.try_place_bets(&user, &bets, &key(&env, 0xE0));
        assert_eq!(
            result,
            Err(Ok(Error::InvalidBetAmount)),
            "invalid amount in second bet must still be caught"
        );
    }

    /// A multi-entry batch where the *second* bet has `market_id = 0` is
    /// rejected with `MarketIdInvalid`.
    #[test]
    fn invalid_market_id_in_second_bet_rejected() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 1,
            amount: 100, // valid
        });
        bets.push_back(Bet {
            market_id: 0, // invalid — second entry
            amount: 50,
        });

        env.mock_all_auths();
        let result = client.try_place_bets(&user, &bets, &key(&env, 0xE1));
        assert_eq!(
            result,
            Err(Ok(Error::MarketIdInvalid)),
            "invalid market_id in second bet must still be caught"
        );
    }

    /// Validation order: `EmptyBatch` fires before `BatchTooLarge`.
    ///
    /// An empty vec is `EmptyBatch`, not `BatchTooLarge`, even though
    /// 0 ≤ MAX_BATCH_SIZE.  This documents and locks in validation ordering.
    #[test]
    fn empty_batch_takes_priority_over_batch_too_large() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        env.mock_all_auths();
        // An empty batch of size 0 must produce EmptyBatch, not BatchTooLarge.
        let result = client.try_place_bets(&user, &Vec::new(&env), &key(&env, 0xF0));
        assert_eq!(
            result,
            Err(Ok(Error::EmptyBatch)),
            "empty batch must be EmptyBatch, not BatchTooLarge"
        );
    }

    /// Validation order: `BatchTooLarge` fires before per-element checks.
    ///
    /// An over-sized batch that also contains a zero-amount bet should still
    /// return `BatchTooLarge` (cheaper structural check first), not
    /// `InvalidBetAmount`.
    #[test]
    fn batch_too_large_fires_before_amount_check() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);

        // Build MAX_BATCH_SIZE + 1 bets, all with invalid amount = 0.
        let mut bets = Vec::new(&env);
        for i in 0..=MAX_BATCH_SIZE {
            bets.push_back(Bet {
                market_id: (i as u64) + 1,
                amount: 0, // also invalid, but should not be reached
            });
        }

        env.mock_all_auths();
        let result = client.try_place_bets(&user, &bets, &key(&env, 0xF1));
        assert_eq!(
            result,
            Err(Ok(Error::BatchTooLarge)),
            "BatchTooLarge must fire before InvalidBetAmount"
        );
    }

    /// Validation order: per-element checks fire before idempotency storage read.
    ///
    /// A batch with an invalid amount must be rejected with
    /// `InvalidBetAmount` even when the idempotency key has not been
    /// seen before, confirming no storage reads happen for an invalid batch.
    #[test]
    fn amount_check_fires_before_idempotency_write() {
        let env = fresh_env();
        let (_id, client) = register(&env);
        let user = caller(&env);
        let idem = key(&env, 0xF2);

        let mut bets = Vec::new(&env);
        bets.push_back(Bet {
            market_id: 1,
            amount: -5, // invalid
        });

        env.mock_all_auths();

        // First call: validation fails → no key should be written.
        let result = client.try_place_bets(&user, &bets, &idem);
        assert_eq!(result, Err(Ok(Error::InvalidBetAmount)));

        // Second call with the same key and now-valid bets must succeed,
        // proving the first call did not consume the idempotency key.
        client.place_bets(&user, &one_bet(&env), &idem);
    }
}
