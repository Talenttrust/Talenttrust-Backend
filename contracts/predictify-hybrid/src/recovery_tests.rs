//! Tests for deterministic failure recovery (#1288) and the `place_bets`
//! compatibility contract (#1280).
//!
//! ```text
//! cargo test -p predictify-hybrid recovery_tests
//! ```

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    vec, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

use crate::{
    batch_hash, BatchReceipt, Bet, DataKey, Error, PredictifyHybrid, PredictifyHybridClient,
    IDEM_KEY_TTL_LEDGERS, MAX_BATCH_SIZE,
};

fn setup() -> (Env, Address, PredictifyHybridClient<'static>, Address) {
    let env = Env::default();
    let id = env.register_contract(None, PredictifyHybrid);
    let client = PredictifyHybridClient::new(&env, &id);
    let user = Address::generate(&env);
    (env, id, client, user)
}

fn key(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn batch(env: &Env, bets: &[(u64, i128)]) -> Vec<Bet> {
    let mut v = Vec::new(env);
    for (market_id, amount) in bets {
        v.push_back(Bet {
            market_id: *market_id,
            amount: *amount,
        });
    }
    v
}

// ── success path & compatibility (#1280) ────────────────────────────────────

#[test]
fn success_stores_receipt_and_keeps_the_legacy_event_shape() {
    let (env, id, client, user) = setup();
    env.mock_all_auths();
    let bets = batch(&env, &[(1, 100), (2, 250)]);
    let k = key(&env, 0x11);

    client.place_bets(&user, &bets, &k);

    let receipt = client.get_batch_receipt(&user, &k).expect("receipt stored");
    assert_eq!(
        receipt,
        BatchReceipt {
            bet_count: 2,
            total_amount: 350,
            batch_hash: batch_hash(&env, &bets),
            applied_ledger: env.ledger().sequence(),
            legacy: false,
        }
    );

    // Exactly the historical event, followed by the new receipt event.
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                id.clone(),
                (Symbol::new(&env, "place_bets"), user.clone()).into_val(&env),
                2u32.into_val(&env),
            ),
            (
                id.clone(),
                (Symbol::new(&env, "bet_rcpt"), user.clone(), k.clone()).into_val(&env),
                (2u32, 350i128, batch_hash(&env, &bets), true).into_val(&env),
            ),
        ]
    );
}

#[test]
fn error_codes_are_stable() {
    // Clients pattern-match on these numbers; they must never be renumbered.
    assert_eq!(Error::IdempotentBatchAlreadyApplied as u32, 1);
    assert_eq!(Error::EmptyBatch as u32, 2);
    assert_eq!(Error::InvalidAmount as u32, 3);
    assert_eq!(Error::BatchTooLarge as u32, 4);
    assert_eq!(Error::AmountOverflow as u32, 5);
}

#[test]
fn max_batch_size_is_queryable() {
    let (_env, _id, client, _user) = setup();
    assert_eq!(client.max_batch_size(), MAX_BATCH_SIZE);
    assert_eq!(MAX_BATCH_SIZE, 100);
}

// ── failures never consume the key (#1288) ──────────────────────────────────

#[test]
fn rejected_batch_does_not_consume_key_and_same_key_retry_succeeds() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();
    let k = key(&env, 0x21);

    let bad = batch(&env, &[(1, 100), (2, 0)]);
    assert_eq!(
        client.try_place_bets(&user, &bad, &k),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(client.get_batch_receipt(&user, &k), None);

    let good = batch(&env, &[(1, 100), (2, 5)]);
    client.place_bets(&user, &good, &k);
    assert_eq!(
        client.get_batch_receipt(&user, &k).unwrap().total_amount,
        105
    );
}

#[test]
fn failed_auth_does_not_consume_key() {
    let (env, _id, client, user) = setup();
    let k = key(&env, 0x22);
    let bets = batch(&env, &[(1, 10)]);

    // No auth mocked: the caller's signature is missing.
    assert!(client.try_place_bets(&user, &bets, &k).is_err());
    assert_eq!(client.get_batch_receipt(&user, &k), None);

    env.mock_all_auths();
    client.place_bets(&user, &bets, &k);
    assert!(client.get_batch_receipt(&user, &k).is_some());
}

#[test]
fn lost_response_is_recovered_by_querying_the_receipt_not_by_reapplying() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();
    let k = key(&env, 0x23);
    let bets = batch(&env, &[(7, 40)]);

    client.place_bets(&user, &bets, &k);
    // Client never saw the response. Querying tells it the batch landed.
    let before = client.get_batch_receipt(&user, &k).expect("applied");
    assert_eq!(before.batch_hash, batch_hash(&env, &bets));

    // A blind resubmission is rejected instead of applied twice…
    assert_eq!(
        client.try_place_bets(&user, &bets, &k),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    // …and the stored receipt is untouched.
    assert_eq!(client.get_batch_receipt(&user, &k), Some(before));
}

#[test]
fn key_reused_for_another_payload_is_rejected_and_detectable_by_hash() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();
    let k = key(&env, 0x24);
    let first = batch(&env, &[(1, 1)]);
    let other = batch(&env, &[(1, 2)]);

    client.place_bets(&user, &first, &k);
    // Compatibility: any reuse of a key is code 1, whatever the payload.
    assert_eq!(
        client.try_place_bets(&user, &other, &k),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    let receipt = client.get_batch_receipt(&user, &k).unwrap();
    assert_eq!(receipt.batch_hash, batch_hash(&env, &first));
    assert_ne!(receipt.batch_hash, batch_hash(&env, &other));
}

// ── validation boundaries & deterministic order ─────────────────────────────

#[test]
fn batch_size_boundary() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();

    let mut max = Vec::new(&env);
    for i in 0..MAX_BATCH_SIZE {
        max.push_back(Bet {
            market_id: i as u64,
            amount: 1,
        });
    }
    client.place_bets(&user, &max, &key(&env, 0x31));
    assert_eq!(
        client
            .get_batch_receipt(&user, &key(&env, 0x31))
            .unwrap()
            .bet_count,
        MAX_BATCH_SIZE
    );

    max.push_back(Bet {
        market_id: 999,
        amount: 1,
    });
    assert_eq!(
        client.try_place_bets(&user, &max, &key(&env, 0x32)),
        Err(Ok(Error::BatchTooLarge))
    );
    assert_eq!(client.get_batch_receipt(&user, &key(&env, 0x32)), None);
}

#[test]
fn amount_boundaries() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();

    client.place_bets(&user, &batch(&env, &[(1, 1)]), &key(&env, 0x41));
    for (seed, amount) in [(0x42u8, 0i128), (0x43, -1), (0x44, i128::MIN)] {
        assert_eq!(
            client.try_place_bets(&user, &batch(&env, &[(1, amount)]), &key(&env, seed)),
            Err(Ok(Error::InvalidAmount))
        );
    }
    assert_eq!(
        client.try_place_bets(
            &user,
            &batch(&env, &[(1, i128::MAX), (2, 1)]),
            &key(&env, 0x45)
        ),
        Err(Ok(Error::AmountOverflow))
    );
    // A single maximal stake is fine.
    client.place_bets(&user, &batch(&env, &[(1, i128::MAX)]), &key(&env, 0x46));
}

#[test]
fn validation_runs_before_idempotency_so_errors_are_deterministic() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();
    let k = key(&env, 0x51);
    client.place_bets(&user, &batch(&env, &[(1, 1)]), &k);

    // Same inputs always give the same error, independent of key history.
    for _ in 0..2 {
        assert_eq!(
            client.try_place_bets(&user, &Vec::new(&env), &k),
            Err(Ok(Error::EmptyBatch))
        );
        assert_eq!(
            client.try_place_bets(&user, &batch(&env, &[(1, -5)]), &k),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_place_bets(&user, &batch(&env, &[(1, 5)]), &k),
            Err(Ok(Error::IdempotentBatchAlreadyApplied))
        );
    }
}

// ── keys, callers, expiry & upgrade ─────────────────────────────────────────

#[test]
fn keys_are_scoped_per_caller() {
    let (env, _id, client, alice) = setup();
    env.mock_all_auths();
    let bob = Address::generate(&env);
    let k = key(&env, 0x61);

    client.place_bets(&alice, &batch(&env, &[(1, 1)]), &k);
    assert_eq!(client.get_batch_receipt(&bob, &k), None);
    client.place_bets(&bob, &batch(&env, &[(1, 9)]), &k);
    assert_eq!(
        client.get_batch_receipt(&alice, &k).unwrap().total_amount,
        1
    );
    assert_eq!(client.get_batch_receipt(&bob, &k).unwrap().total_amount, 9);
}

#[test]
fn key_and_receipt_expire_together_and_the_contract_stays_live() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();
    let k = key(&env, 0x62);
    let bets = batch(&env, &[(1, 1)]);

    client.place_bets(&user, &bets, &k);
    env.ledger()
        .with_mut(|li| li.sequence_number += IDEM_KEY_TTL_LEDGERS - 1);
    assert!(
        client.get_batch_receipt(&user, &k).is_some(),
        "still protected inside the window"
    );

    env.ledger().with_mut(|li| li.sequence_number += 2);
    assert_eq!(
        client.get_batch_receipt(&user, &k),
        None,
        "receipt expired with the key"
    );
    // The instance outlives the key, so the same token is accepted as a new batch.
    client.place_bets(&user, &bets, &k);
    assert!(client.get_batch_receipt(&user, &k).is_some());
}

#[test]
fn keys_consumed_by_the_previous_version_are_still_honoured() {
    let (env, id, client, user) = setup();
    env.mock_all_auths();
    let k = key(&env, 0x71);

    // Pre-#1288 versions stored a `true` sentinel in instance storage.
    env.as_contract(&id, || {
        env.storage()
            .instance()
            .set(&DataKey::PlaceBetsIdem(user.clone(), k.clone()), &true);
    });

    assert_eq!(
        client.try_place_bets(&user, &batch(&env, &[(1, 1)]), &k),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    let receipt = client
        .get_batch_receipt(&user, &k)
        .expect("legacy key reported");
    assert!(receipt.legacy);
    assert_eq!(receipt.bet_count, 0);
}

#[test]
fn zero_key_keeps_the_deprecated_no_dedup_behaviour() {
    let (env, _id, client, user) = setup();
    env.mock_all_auths();
    let zero = BytesN::from_array(&env, &[0u8; 32]);
    let bets = batch(&env, &[(1, 1)]);

    client.place_bets(&user, &bets, &zero);
    client.place_bets(&user, &bets, &zero);
    assert_eq!(client.get_batch_receipt(&user, &zero), None);
    // Validation still applies on the zero-key path.
    assert_eq!(
        client.try_place_bets(&user, &batch(&env, &[(1, 0)]), &zero),
        Err(Ok(Error::InvalidAmount))
    );
}
