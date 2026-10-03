use soroban_sdk::{
    contract, contractimpl,
    testutils::{storage::Temporary as _, Address as _, EnvTestConfig, Events as _, Ledger},
    Address, BytesN, Env, Vec,
};

use crate::{
    storage::consume_idempotency_key, Bet, DataKey, Error, PredictifyHybrid,
    PredictifyHybridClient, IDEM_KEY_TTL_LEDGERS,
};

fn fresh_env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

fn setup() -> (Env, Address, Address) {
    let env = fresh_env();
    env.ledger().with_mut(|li| {
        li.sequence_number = 100;
        li.min_persistent_entry_ttl = IDEM_KEY_TTL_LEDGERS * 3;
        li.min_temp_entry_ttl = 16;
    });
    let id = env.register_contract(None, PredictifyHybrid);
    let user = Address::generate(&env);
    env.mock_all_auths();
    (env, id, user)
}

fn token(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn bets(env: &Env) -> Vec<Bet> {
    soroban_sdk::vec![
        env,
        Bet {
            market_id: 1,
            amount: 100
        }
    ]
}

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| li.sequence_number += ledgers);
}

fn committed_event_count(env: &Env) -> usize {
    // SDK 21 Events::all includes diagnostic copies from rolled-back calls.
    // The snapshot distinguishes those from committed contract events.
    env.to_snapshot()
        .events
        .0
        .iter()
        .filter(|event| {
            !event.failed_call && event.event.type_ == soroban_sdk::xdr::ContractEventType::Contract
        })
        .count()
}

#[test]
fn reservation_is_temporary_and_has_exact_independent_ttl() {
    let (env, id, user) = setup();
    let key = token(&env, 1);
    PredictifyHybridClient::new(&env, &id).place_bets(&user, &bets(&env), &key);
    env.as_contract(&id, || {
        let data_key = DataKey::PlaceBetsIdem(user, key);
        assert!(!env.storage().instance().has(&data_key));
        assert_eq!(
            env.storage().temporary().get::<_, u32>(&data_key),
            Some(100 + IDEM_KEY_TTL_LEDGERS)
        );
        assert_eq!(
            env.storage().temporary().get_ttl(&data_key),
            IDEM_KEY_TTL_LEDGERS
        );
    });
    assert_eq!(env.events().all().len(), 1);
}

#[test]
fn duplicate_at_inclusive_deadline_rejected_then_next_ledger_accepted() {
    let (env, id, user) = setup();
    let client = PredictifyHybridClient::new(&env, &id);
    let key = token(&env, 2);
    client.place_bets(&user, &bets(&env), &key);
    advance(&env, IDEM_KEY_TTL_LEDGERS);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &key),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    assert_eq!(env.events().all().len(), 1);
    advance(&env, 1);
    client.place_bets(&user, &bets(&env), &key);
    assert_eq!(env.events().all().len(), 2);
}

#[test]
fn newer_tokens_and_duplicate_retries_do_not_renew_older_tokens() {
    let (env, id, user) = setup();
    let client = PredictifyHybridClient::new(&env, &id);
    let first = token(&env, 3);
    let second = token(&env, 4);
    client.place_bets(&user, &bets(&env), &first);
    advance(&env, IDEM_KEY_TTL_LEDGERS / 2);
    client.place_bets(&user, &bets(&env), &second);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &first),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    env.as_contract(&id, || {
        assert_eq!(
            env.storage()
                .temporary()
                .get_ttl(&DataKey::PlaceBetsIdem(user.clone(), first.clone())),
            IDEM_KEY_TTL_LEDGERS / 2
        );
    });
    advance(&env, IDEM_KEY_TTL_LEDGERS / 2 + 1);
    client.place_bets(&user, &bets(&env), &first);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &second),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    assert_eq!(env.events().all().len(), 3);
}

#[test]
fn logical_deadline_wins_over_longer_network_minimum_retention() {
    let (env, id, user) = setup();
    env.ledger()
        .with_mut(|li| li.min_temp_entry_ttl = IDEM_KEY_TTL_LEDGERS * 2);
    let client = PredictifyHybridClient::new(&env, &id);
    let key = token(&env, 5);
    client.place_bets(&user, &bets(&env), &key);
    advance(&env, IDEM_KEY_TTL_LEDGERS + 1);
    env.as_contract(&id, || {
        assert!(env
            .storage()
            .temporary()
            .has(&DataKey::PlaceBetsIdem(user.clone(), key.clone())));
    });
    client.place_bets(&user, &bets(&env), &key);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &key),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
}

#[test]
fn caller_authentication_is_required_and_failure_does_not_consume_token() {
    let env = fresh_env();
    let id = env.register_contract(None, PredictifyHybrid);
    let client = PredictifyHybridClient::new(&env, &id);
    let user = Address::generate(&env);
    let key = token(&env, 6);
    assert!(client.try_place_bets(&user, &bets(&env), &key).is_err());
    assert!(env.events().all().is_empty());
    env.as_contract(&id, || {
        assert!(!env
            .storage()
            .temporary()
            .has(&DataKey::PlaceBetsIdem(user.clone(), key.clone())));
        assert!(!env.storage().instance().has(&DataKey::LegacyIdemDeadline));
    });
    env.mock_all_auths();
    client.place_bets(&user, &bets(&env), &key);
}

#[test]
fn empty_batch_can_be_corrected_and_retried_with_same_token() {
    let (env, id, user) = setup();
    let client = PredictifyHybridClient::new(&env, &id);
    let key = token(&env, 7);
    assert_eq!(
        client.try_place_bets(&user, &Vec::new(&env), &key),
        Err(Ok(Error::EmptyBatch))
    );
    assert!(env.events().all().is_empty());
    env.as_contract(&id, || {
        assert!(!env.storage().instance().has(&DataKey::LegacyIdemDeadline))
    });
    client.place_bets(&user, &bets(&env), &key);
}

#[test]
fn insufficient_network_ttl_fails_without_writes_and_retry_succeeds() {
    let (env, id, user) = setup();
    let client = PredictifyHybridClient::new(&env, &id);
    let key = token(&env, 8);
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 16;
        li.max_entry_ttl = IDEM_KEY_TTL_LEDGERS;
    });
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &key),
        Err(Ok(Error::IdempotencyRetentionUnavailable))
    );
    assert!(env.events().all().is_empty());
    env.as_contract(&id, || {
        assert!(!env
            .storage()
            .temporary()
            .has(&DataKey::PlaceBetsIdem(user.clone(), key.clone())));
        assert!(!env.storage().instance().has(&DataKey::LegacyIdemDeadline));
    });
    // max_ttl excludes the current ledger, hence +1 is the exact boundary.
    env.ledger()
        .with_mut(|li| li.max_entry_ttl = IDEM_KEY_TTL_LEDGERS + 1);
    client.place_bets(&user, &bets(&env), &key);
}

#[test]
fn deadline_overflow_is_reported_without_consuming_token() {
    let env = fresh_env();
    env.ledger().with_mut(|li| {
        li.sequence_number = u32::MAX - IDEM_KEY_TTL_LEDGERS + 1;
        li.min_persistent_entry_ttl = 1;
        li.min_temp_entry_ttl = 1;
        li.max_entry_ttl = 1;
    });
    let id = env.register_contract(None, PredictifyHybrid);
    let user = Address::generate(&env);
    let key = token(&env, 9);
    env.mock_all_auths();
    let client = PredictifyHybridClient::new(&env, &id);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &key),
        Err(Ok(Error::IdempotencyRetentionUnavailable))
    );
    env.as_contract(&id, || {
        assert!(!env
            .storage()
            .temporary()
            .has(&DataKey::PlaceBetsIdem(user, key)))
    });
    assert!(env.events().all().is_empty());
}

#[test]
fn legacy_sentinel_preserved_until_fixed_cutoff_then_lazily_replaced() {
    let (env, id, user) = setup();
    let client = PredictifyHybridClient::new(&env, &id);
    let old = token(&env, 10);
    let legacy_key = DataKey::PlaceBetsIdem(user.clone(), old.clone());
    env.as_contract(&id, || env.storage().instance().set(&legacy_key, &true));
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &old),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    env.as_contract(&id, || {
        assert!(!env.storage().instance().has(&DataKey::LegacyIdemDeadline))
    });
    let new = token(&env, 11);
    client.place_bets(&user, &bets(&env), &new);
    advance(&env, IDEM_KEY_TTL_LEDGERS);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &old),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    // A later success must not restart the legacy migration window.
    client.place_bets(&user, &bets(&env), &token(&env, 12));
    advance(&env, 1);
    client.place_bets(&user, &bets(&env), &old);
    env.as_contract(&id, || {
        assert!(!env.storage().instance().has(&legacy_key));
        assert!(env.storage().temporary().has(&legacy_key));
        assert_eq!(
            env.storage()
                .instance()
                .get::<_, u32>(&DataKey::LegacyIdemDeadline),
            Some(100 + IDEM_KEY_TTL_LEDGERS)
        );
    });
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &old),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
}

#[test]
fn zero_key_does_not_create_reservation_or_start_migration() {
    let (env, id, user) = setup();
    let client = PredictifyHybridClient::new(&env, &id);
    let zero = token(&env, 0);
    client.place_bets(&user, &bets(&env), &zero);
    client.place_bets(&user, &bets(&env), &zero);
    env.as_contract(&id, || {
        assert!(env.storage().temporary().all().is_empty());
        assert!(!env.storage().instance().has(&DataKey::LegacyIdemDeadline));
    });
    assert_eq!(env.events().all().len(), 2);
}

#[test]
fn malformed_temporary_receipt_fails_closed_and_other_tokens_remain_usable() {
    let (env, id, user) = setup();
    let bad = token(&env, 14);
    let bad_key = DataKey::PlaceBetsIdem(user.clone(), bad.clone());
    env.as_contract(&id, || env.storage().temporary().set(&bad_key, &false));
    let client = PredictifyHybridClient::new(&env, &id);

    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &bad),
        Err(Ok(Error::InvalidIdempotencyState))
    );
    env.as_contract(&id, || {
        assert_eq!(
            env.storage().temporary().get::<_, bool>(&bad_key),
            Some(false)
        );
        assert!(!env.storage().instance().has(&DataKey::LegacyIdemDeadline));
    });
    assert_eq!(committed_event_count(&env), 0);

    let good = token(&env, 15);
    client.place_bets(&user, &bets(&env), &good);
    assert_eq!(committed_event_count(&env), 1);
    env.as_contract(&id, || env.storage().temporary().remove(&bad_key));
    client.place_bets(&user, &bets(&env), &bad);
    assert_eq!(committed_event_count(&env), 2);
}

#[test]
fn malformed_migration_deadline_preserves_legacy_marker_until_repaired() {
    let (env, id, user) = setup();
    let old = token(&env, 16);
    let old_key = DataKey::PlaceBetsIdem(user.clone(), old.clone());
    env.as_contract(&id, || {
        env.storage().instance().set(&old_key, &true);
        env.storage()
            .instance()
            .set(&DataKey::LegacyIdemDeadline, &false);
    });
    let client = PredictifyHybridClient::new(&env, &id);

    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &old),
        Err(Ok(Error::InvalidIdempotencyState))
    );
    env.as_contract(&id, || {
        assert_eq!(
            env.storage().instance().get::<_, bool>(&old_key),
            Some(true)
        );
        assert_eq!(
            env.storage()
                .instance()
                .get::<_, bool>(&DataKey::LegacyIdemDeadline),
            Some(false)
        );
        env.storage()
            .instance()
            .remove(&DataKey::LegacyIdemDeadline);
    });
    assert_eq!(committed_event_count(&env), 0);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &old),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
}

#[test]
fn malformed_legacy_marker_cannot_be_erased_after_migration_cutoff() {
    let (env, id, user) = setup();
    let old = token(&env, 17);
    let old_key = DataKey::PlaceBetsIdem(user.clone(), old.clone());
    env.as_contract(&id, || env.storage().instance().set(&old_key, &false));
    let client = PredictifyHybridClient::new(&env, &id);

    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &old),
        Err(Ok(Error::InvalidIdempotencyState))
    );
    client.place_bets(&user, &bets(&env), &token(&env, 18));
    advance(&env, IDEM_KEY_TTL_LEDGERS + 1);
    assert_eq!(
        client.try_place_bets(&user, &bets(&env), &old),
        Err(Ok(Error::InvalidIdempotencyState))
    );
    env.as_contract(&id, || {
        assert_eq!(
            env.storage().instance().get::<_, bool>(&old_key),
            Some(false)
        );
        assert!(!env.storage().temporary().has(&old_key));
    });
    assert_eq!(committed_event_count(&env), 1);
}

// Exercise rollback after reservation inside a real host transaction. The
// production batch currently only emits an event; future effects must keep
// this same commit/rollback boundary rather than catching and ignoring errors.
#[contract]
struct FailingBatch;

#[contractimpl]
impl FailingBatch {
    pub fn run(env: Env, user: Address, key: BytesN<32>, fail: bool) -> Result<(), Error> {
        user.require_auth();
        consume_idempotency_key(&env, &user, &key)?;
        env.events()
            .publish((soroban_sdk::symbol_short!("applied"),), true);
        if fail {
            Err(Error::EmptyBatch)
        } else {
            Ok(())
        }
    }
}

#[test]
fn downstream_error_rolls_back_reservation_migration_and_events() {
    let (env, _, user) = setup();
    let id = env.register_contract(None, FailingBatch);
    let client = FailingBatchClient::new(&env, &id);
    let key = token(&env, 13);
    assert_eq!(
        client.try_run(&user, &key, &true),
        Err(Ok(Error::EmptyBatch))
    );
    env.as_contract(&id, || {
        assert!(!env
            .storage()
            .temporary()
            .has(&DataKey::PlaceBetsIdem(user.clone(), key.clone())));
        assert!(!env.storage().instance().has(&DataKey::LegacyIdemDeadline));
    });
    assert_eq!(committed_event_count(&env), 0);
    client.run(&user, &key, &false);
    assert_eq!(
        client.try_run(&user, &key, &false),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    assert_eq!(committed_event_count(&env), 1);
}
