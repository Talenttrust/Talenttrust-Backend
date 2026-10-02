//! Focused tests for the state invariants owned by `bets::place_bets`.
//!
//! These complement [`crate::batch_operations_tests`], which covers the
//! idempotency key lifecycle. Here we pin the validation, authorization,
//! all-or-nothing and bounded-state properties: a rejection must never
//! leave state behind, a forbidden caller must never mutate state, and
//! the contract instance must never accumulate per-batch data.
//!
//! Run with:
//! ```text
//! cargo test -p predictify-hybrid -- --nocapture
//! ```

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, BytesN, Env, Symbol, TryFromVal, TryIntoVal, Val, Vec,
};

use crate::{
    bets::MAX_BETS_PER_BATCH, BatchReceipt, Bet, DataKey, Error, PredictifyHybrid,
    PredictifyHybridClient,
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

fn one_bet(env: &Env) -> Vec<Bet> {
    batch_of(env, &[bet(1, 100)])
}

/// `count` bets, one per market, all of `amount` stroops.
fn repeated_bets(env: &Env, count: u32, amount: i128) -> Vec<Bet> {
    let mut v = Vec::new(env);
    for i in 0..count {
        v.push_back(bet(u64::from(i) + 1, amount));
    }
    v
}

/// Read the durable receipt for `(user, idem)` as the contract sees it.
///
/// NOTE: `Env::as_contract` pushes a test frame whose rollback discards
/// the event buffer, so anything that inspects `env.events()` must run
/// *before* calling this helper.
fn receipt(env: &Env, contract: &Address, user: &Address, idem: &BytesN<32>) -> Option<BatchReceipt> {
    env.as_contract(contract, || {
        env.storage()
            .temporary()
            .get(&DataKey::PlaceBetsIdem(user.clone(), idem.clone()))
    })
}

/// `true` when an event with the given name and this caller has been
/// published in the current test run.
fn has_event(env: &Env, name: &str, caller: &Address) -> bool {
    let wanted = Symbol::new(env, name);
    env.events().all().iter().any(|(_, topics, _)| {
        let Some(first) = topics.get(0) else {
            return false;
        };
        let Ok(symbol) = Symbol::try_from_val(env, &first) else {
            return false;
        };
        symbol == wanted && topics.get(1).and_then(|t| t.try_into_val(env).ok()) == Some(caller.clone())
    })
}

/// Decode the `bets_placed` payload, which is
/// `(bet_count, total_amount, deduplicated)`.
fn bets_placed_payload(env: &Env) -> (u32, i128, bool) {
    let wanted = Symbol::new(env, "bets_placed");
    for (_, topics, data) in env.events().all().iter() {
        let name = topics.get(0).and_then(|t| Symbol::try_from_val(env, &t).ok());
        if name != Some(wanted.clone()) {
            continue;
        }
        // A tuple payload is encoded as a `Vec<Val>`.
        let Ok(fields) = <Vec<Val>>::try_from_val(env, &data) else {
            continue;
        };
        let count: Option<u32> = fields.get(0).and_then(|v| v.try_into_val(env).ok());
        let total: Option<i128> = fields.get(1).and_then(|v| v.try_into_val(env).ok());
        let dedup: Option<bool> = fields.get(2).and_then(|v| v.try_into_val(env).ok());
        if let (Some(count), Some(total), Some(dedup)) = (count, total, dedup) {
            return (count, total, dedup);
        }
    }
    panic!("no decodable bets_placed event was published");
}

/// Give the test ledger a persistent-entry TTL floor below
/// `CONTRACT_TTL_THRESHOLD_LEDGERS`.
///
/// `extend_ttl` only fires when an entry's *remaining* TTL is already
/// under the threshold, so the contract's instance/code bump cannot be
/// observed from the test env's 17_280-ledger default unless the floor
/// starts lower. A low floor is also what a real network looks like
/// relative to the bump amount.
fn use_low_entry_ttl_floor(env: &Env) {
    env.ledger()
        .with_mut(|li| li.min_persistent_entry_ttl = 500);
}

// ── I5a: market_id 0 is rejected ─────────────────────────────────────────────

#[test]
fn zero_market_id_rejected() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let bets = batch_of(&env, &[bet(0, 100)]);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &bets, &key(&env, 0x11));
    assert_eq!(
        result,
        Err(Ok(Error::InvalidMarketId)),
        "market_id 0 is the reserved no-market sentinel and must be rejected"
    );
}

#[test]
fn zero_market_id_in_later_position_rejected() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let bets = batch_of(&env, &[bet(7, 100), bet(0, 100)]);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &bets, &key(&env, 0x12));
    assert_eq!(
        result,
        Err(Ok(Error::InvalidMarketId)),
        "a bad bet anywhere in the batch must reject the whole batch"
    );
}

// ── I5b: non-positive amount is rejected ─────────────────────────────────────

#[test]
fn zero_amount_rejected() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let bets = batch_of(&env, &[bet(1, 0)]);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &bets, &key(&env, 0x13));
    assert_eq!(
        result,
        Err(Ok(Error::InvalidBetAmount)),
        "a zero-amount bet is a no-op that must not consume a key"
    );
}

#[test]
fn negative_amount_rejected() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let bets = batch_of(&env, &[bet(1, 100), bet(2, -1)]);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &bets, &key(&env, 0x14));
    assert_eq!(
        result,
        Err(Ok(Error::InvalidBetAmount)),
        "a negative amount would credit one side of a market and debit the other"
    );
}

#[test]
fn most_negative_amount_rejected() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let bets = batch_of(&env, &[bet(1, i128::MIN)]);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &bets, &key(&env, 0x15));
    assert_eq!(
        result,
        Err(Ok(Error::InvalidBetAmount)),
        "i128::MIN must be rejected without overflowing the running total"
    );
}

// ── I5c: the batch total is checked, not wrapped ─────────────────────────────

#[test]
fn batch_total_overflow_rejected() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    // Every bet is individually valid; only the running sum overflows.
    // With debug assertions off (the release profile) an unchecked sum
    // would wrap to a negative total here.
    let bets = batch_of(&env, &[bet(1, i128::MAX), bet(2, 1)]);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &bets, &key(&env, 0x16));
    assert_eq!(
        result,
        Err(Ok(Error::BatchAmountOverflow)),
        "the batch total must be computed with checked arithmetic"
    );
}

#[test]
fn largest_single_bet_accepted() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x17);
    let bets = batch_of(&env, &[bet(1, i128::MAX)]);

    env.mock_all_auths();
    client.place_bets(&user, &bets, &idem);

    // Boundary: i128::MAX is representable and must be accepted verbatim.
    let stored = receipt(&env, &id, &user, &idem).expect("receipt must exist");
    assert_eq!(stored.total_amount, i128::MAX);
}

#[test]
fn smallest_positive_bet_accepted() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x18);
    let bets = batch_of(&env, &[bet(1, 1)]);

    env.mock_all_auths();
    client.place_bets(&user, &bets, &idem);

    // Boundary: 1 stroop is the smallest legal stake.
    let stored = receipt(&env, &id, &user, &idem).expect("receipt must exist");
    assert_eq!(stored.total_amount, 1);
}

// ── I6: batch size bound ─────────────────────────────────────────────────────

#[test]
fn batch_at_max_size_accepted() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x19);
    let bets = repeated_bets(&env, MAX_BETS_PER_BATCH, 10);

    env.mock_all_auths();
    client.place_bets(&user, &bets, &idem);

    // Boundary: exactly MAX_BETS_PER_BATCH is still accepted.
    let stored = receipt(&env, &id, &user, &idem).expect("receipt must exist");
    assert_eq!(stored.bet_count, MAX_BETS_PER_BATCH);
    assert_eq!(stored.total_amount, 10 * i128::from(MAX_BETS_PER_BATCH));
}

#[test]
fn batch_one_over_max_rejected() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let bets = repeated_bets(&env, MAX_BETS_PER_BATCH + 1, 10);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &bets, &key(&env, 0x1a));
    assert_eq!(
        result,
        Err(Ok(Error::BatchTooLarge)),
        "one bet over the bound must be rejected"
    );
}

// ── I1: authorization ────────────────────────────────────────────────────────

#[test]
fn unauthorized_caller_is_rejected_and_writes_nothing() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x1b);

    // Nobody authorizes: `caller.require_auth()` must fail, so the batch
    // is never attributed to `user`.
    env.mock_auths(&[]);

    let result = client.try_place_bets(&user, &one_bet(&env), &idem);
    assert!(
        result.is_err(),
        "a caller that did not authorize must not be able to place bets"
    );

    // I2/I4: the forbidden attempt must not have consumed the token.
    assert!(
        receipt(&env, &id, &user, &idem).is_none(),
        "an unauthorized attempt must not create a receipt"
    );
}

// ── I2/I4: a rejected batch leaves no state and does not burn the key ────────

#[test]
fn rejected_batch_does_not_consume_the_idempotency_key() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x1c);

    env.mock_all_auths();

    // Invalid content: rejected.
    let invalid = batch_of(&env, &[bet(1, -5)]);
    assert_eq!(
        client.try_place_bets(&user, &invalid, &idem),
        Err(Ok(Error::InvalidBetAmount))
    );
    assert!(
        receipt(&env, &id, &user, &idem).is_none(),
        "a rejected batch must leave no receipt behind"
    );

    // Oversized: also rejected, still no receipt.
    let oversized = repeated_bets(&env, MAX_BETS_PER_BATCH + 1, 10);
    assert_eq!(
        client.try_place_bets(&user, &oversized, &idem),
        Err(Ok(Error::BatchTooLarge))
    );
    assert!(receipt(&env, &id, &user, &idem).is_none());

    // The same token must still be usable for a corrected batch. This is
    // the property that makes client-side retry-after-rejection safe.
    client.place_bets(&user, &batch_of(&env, &[bet(1, 250)]), &idem);

    let stored = receipt(&env, &id, &user, &idem).expect("receipt must exist");
    assert_eq!(stored.bet_count, 1);
    assert_eq!(stored.total_amount, 250);
}

#[test]
fn duplicate_key_after_success_is_read_only() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x1d);

    env.mock_all_auths();
    client.place_bets(&user, &batch_of(&env, &[bet(1, 100)]), &idem);
    let after_first = receipt(&env, &id, &user, &idem).expect("receipt must exist");

    // An honest retry of the same batch reads as a duplicate.
    for _ in 0..3 {
        assert_eq!(
            client.try_place_bets(&user, &batch_of(&env, &[bet(1, 100)]), &idem),
            Err(Ok(Error::IdempotentBatchAlreadyApplied))
        );
    }

    // A different batch under the same token reads as a collision, but is
    // still rejected before any mutation (I8).
    for _ in 0..3 {
        assert_eq!(
            client.try_place_bets(&user, &batch_of(&env, &[bet(2, 999)]), &idem),
            Err(Ok(Error::IdempotencyKeyReusedWithDifferentBatch))
        );
    }

    // A replay must not be able to change the recorded state, whatever
    // payload it carries.
    let after_replays = receipt(&env, &id, &user, &idem).expect("receipt must exist");
    assert_eq!(after_first, after_replays);
}

// ── I2: the receipt records what was applied ─────────────────────────────────

#[test]
fn receipt_records_the_applied_batch() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x1e);
    let bets = batch_of(&env, &[bet(1, 100), bet(2, 250), bet(3, 7)]);

    let expected_ledger = env.ledger().sequence();
    env.mock_all_auths();
    client.place_bets(&user, &bets, &idem);

    let stored = receipt(&env, &id, &user, &idem).expect("receipt must exist");
    assert_eq!(stored.bet_count, 3);
    assert_eq!(stored.total_amount, 357);
    assert_eq!(stored.applied_at_ledger, expected_ledger);
}

#[test]
fn duplicate_markets_are_aggregated_not_rejected() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x1f);
    // Two independent stakes on the same market: each Bet is its own
    // stake, so this is legal and the totals add up.
    let bets = batch_of(&env, &[bet(1, 100), bet(1, 150)]);

    env.mock_all_auths();
    client.place_bets(&user, &bets, &idem);

    let stored = receipt(&env, &id, &user, &idem).expect("receipt must exist");
    assert_eq!(stored.bet_count, 2);
    assert_eq!(stored.total_amount, 250);
}

#[test]
fn receipt_is_scoped_to_the_caller() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user_a = caller(&env);
    let user_b = caller(&env);
    let shared = key(&env, 0x20);

    env.mock_all_auths();
    client.place_bets(&user_a, &one_bet(&env), &shared);

    assert!(receipt(&env, &id, &user_a, &shared).is_some());
    assert!(
        receipt(&env, &id, &user_b, &shared).is_none(),
        "one caller's key must never satisfy another caller's dedup check"
    );
}

// ── I7: the contract instance must not accumulate per-batch state ────────────

#[test]
fn receipts_never_land_in_instance_storage() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);

    env.mock_all_auths();
    for i in 0..25u8 {
        client.place_bets(&user, &one_bet(&env), &key(&env, i + 1));
    }

    // I7 regression guard: instance storage is a single bounded ledger
    // entry. One key per batch there grows without limit and eventually
    // exceeds max_entry_size, which disables the contract for every
    // caller. Receipts must be per-key temporary entries instead.
    for i in 0..25u8 {
        let data_key = DataKey::PlaceBetsIdem(user.clone(), key(&env, i + 1));
        let in_instance = env.as_contract(&id, || env.storage().instance().has(&data_key));
        assert!(
            !in_instance,
            "batch {} wrote a receipt into the bounded instance entry",
            i
        );
    }

    // ...and every one of them is present in temporary storage.
    for i in 0..25u8 {
        assert!(receipt(&env, &id, &user, &key(&env, i + 1)).is_some());
    }
}

// ── Contract instance / code liveness ───────────────────────────────────────

#[test]
fn contract_stays_callable_after_the_receipt_window_elapses() {
    let env = Env::default();
    use_low_entry_ttl_floor(&env);
    let (_id, client) = register(&env);
    let user = caller(&env);

    env.mock_all_auths();
    client.place_bets(&user, &one_bet(&env), &key(&env, 0x21));

    // Advance past the receipt TTL. The receipt is gone, but the contract
    // instance and its code must still be live — otherwise every caller
    // gets a host error until someone pays for a restore.
    env.ledger().with_mut(|li| {
        li.sequence_number += crate::IDEM_KEY_TTL_LEDGERS + 1;
    });

    client.place_bets(&user, &one_bet(&env), &key(&env, 0x22));
}

#[test]
fn contract_stays_callable_after_the_zero_key_path() {
    let env = Env::default();
    use_low_entry_ttl_floor(&env);
    let (_id, client) = register(&env);
    let user = caller(&env);
    let zero = zero_key(&env);

    // The deprecated path writes no receipt, so bumping the contract TTL
    // there is the only thing keeping the contract alive for these
    // callers.
    env.mock_all_auths();
    client.place_bets(&user, &one_bet(&env), &zero);

    env.ledger().with_mut(|li| {
        li.sequence_number += crate::IDEM_KEY_TTL_LEDGERS + 1;
    });

    client.place_bets(&user, &one_bet(&env), &zero);
}

// ── Deprecated zero-key path still validates ─────────────────────────────────

#[test]
fn zero_key_path_still_enforces_validation() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let zero = zero_key(&env);

    env.mock_all_auths();
    let result = client.try_place_bets(&user, &batch_of(&env, &[bet(0, 100)]), &zero);
    assert_eq!(
        result,
        Err(Ok(Error::InvalidMarketId)),
        "opting out of dedup must not opt out of validation"
    );

    let result = client.try_place_bets(&user, &batch_of(&env, &[bet(1, 0)]), &zero);
    assert_eq!(result, Err(Ok(Error::InvalidBetAmount)));
}

#[test]
fn zero_key_path_writes_no_receipt() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let zero = zero_key(&env);

    env.mock_all_auths();
    client.place_bets(&user, &one_bet(&env), &zero);

    assert!(
        receipt(&env, &id, &user, &zero).is_none(),
        "the deprecated path must not accumulate durable state"
    );
}

// ── Observability ────────────────────────────────────────────────────────────

#[test]
fn success_publishes_both_the_current_and_legacy_events() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);

    env.mock_all_auths();
    client.place_bets(&user, &one_bet(&env), &key(&env, 0x30));

    assert!(
        has_event(&env, "bets_placed", &user),
        "the documented success event must be emitted"
    );
    assert!(
        has_event(&env, "place_bets", &user),
        "the pre-#1277 event must keep being emitted for existing indexers"
    );
}

#[test]
fn rejection_publishes_no_batch_event() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);

    env.mock_all_auths();
    let _ = client.try_place_bets(&user, &batch_of(&env, &[bet(1, -1)]), &key(&env, 0x31));

    // A `bets_placed` event for a batch that was never applied would make
    // an off-chain indexer believe the stakes exist.
    assert!(
        !has_event(&env, "bets_placed", &user),
        "no batch event may be published for a rejected batch"
    );
    assert!(!has_event(&env, "place_bets", &user));
}

#[test]
fn bets_placed_data_matches_the_receipt() {
    let env = Env::default();
    let (id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x32);
    let bets = batch_of(&env, &[bet(1, 40), bet(2, 60)]);

    env.mock_all_auths();
    client.place_bets(&user, &bets, &idem);

    // Events first: `receipt` enters a test frame, which discards the
    // event buffer.
    let (bet_count, total_amount, deduplicated) = bets_placed_payload(&env);
    let stored = receipt(&env, &id, &user, &idem).expect("receipt must exist");

    assert_eq!(bet_count, stored.bet_count, "event count must match the receipt");
    assert_eq!(
        total_amount, stored.total_amount,
        "event total must match the receipt"
    );
    assert!(deduplicated, "a keyed submission must be reported as deduplicated");
}

#[test]
fn deduplicated_marker_is_false_for_the_zero_key_path() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);

    env.mock_all_auths();
    client.place_bets(&user, &one_bet(&env), &zero_key(&env));

    let (_bet_count, _total_amount, deduplicated) = bets_placed_payload(&env);
    assert!(
        !deduplicated,
        "indexers must be able to tell non-deduplicated submissions apart"
    );
}

#[test]
fn idempotency_key_is_never_published_in_an_event() {
    let env = Env::default();
    let (_id, client) = register(&env);
    let user = caller(&env);
    let idem = key(&env, 0x33);

    env.mock_all_auths();
    client.place_bets(&user, &one_bet(&env), &idem);

    // The token is a replay credential for its owner and on-chain logs are
    // public and permanent, so it must not appear in any topic or payload.
    for (_, topics, data) in env.events().all().iter() {
        for topic in topics.iter() {
            assert!(
                BytesN::<32>::try_from_val(&env, &topic).is_err(),
                "an event topic must never carry the raw idempotency key"
            );
        }
        assert!(
            BytesN::<32>::try_from_val(&env, &data).is_err(),
            "event data must never carry the raw idempotency key"
        );
    }
}
