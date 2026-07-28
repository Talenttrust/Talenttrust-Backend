//! Integration tests for `place_bets` idempotency semantics.
//!
//! Run with:
//! ```text
//! cargo test -p predictify-hybrid batch_operations_tests -- --nocapture
//! ```

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env, Vec,
};

use crate::{bets::Bet, errors::Error, storage::IDEM_KEY_TTL_LEDGERS, PredictifyHybridClient};

// ── helpers ──────────────────────────────────────────────────────────────────

fn fresh_env() -> Env {
    Env::default()
}

fn register(env: &Env) -> (Address, PredictifyHybridClient) {
    let contract_id = env.register(crate::PredictifyHybrid, ());
    let client = PredictifyHybridClient::new(env, &contract_id);
    (contract_id, client)
}

fn caller(env: &Env) -> Address {
    Address::generate(env)
}

fn key(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
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

mod batch_operations_tests {
    use super::*;

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
}
