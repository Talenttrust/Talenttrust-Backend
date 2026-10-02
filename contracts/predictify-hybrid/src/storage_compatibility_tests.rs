use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events},
    vec,
    xdr::ToXdr,
    Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

use crate::{Bet, DataKey, Error, PredictifyHybrid, PredictifyHybridClient};

// Freeze a pre-upgrade caller independently of the current exported types.
#[soroban_sdk::contracttype]
#[derive(Clone)]
pub struct LegacyBet {
    pub market_id: u64,
    pub amount: i128,
}

#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum LegacyError {
    IdempotentBatchAlreadyApplied = 1,
    EmptyBatch = 2,
}

#[soroban_sdk::contractclient(name = "LegacyClient")]
#[allow(dead_code)] // The trait defines the generated caller ABI; its client is used below.
pub trait LegacyInterface {
    fn place_bets(
        env: Env,
        caller: Address,
        bets: Vec<LegacyBet>,
        idempotency_key: BytesN<32>,
    ) -> Result<(), LegacyError>;
}

fn setup() -> (Env, Address, Address) {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let contract = env.register_contract(None, PredictifyHybrid);
    let caller = Address::generate(&env);
    (env, contract, caller)
}

fn bets(env: &Env) -> Vec<Bet> {
    vec![
        env,
        Bet {
            market_id: 1,
            amount: 100,
        },
    ]
}

// Independent legacy fixture: do not construct this through today's DataKey.
fn legacy_key(env: &Env, caller: &Address, token: &BytesN<32>) -> Vec<Val> {
    vec![
        env,
        Symbol::new(env, "PlaceBetsIdem").into_val(env),
        caller.into_val(env),
        token.into_val(env),
    ]
}

#[test]
fn serialized_key_retains_legacy_variant_name_and_field_order() {
    let (env, _, caller) = setup();
    for seed in [0, 1, 255] {
        let token = BytesN::from_array(&env, &[seed; 32]);
        let actual: Val = DataKey::PlaceBetsIdem(caller.clone(), token.clone()).into_val(&env);
        let expected: Val = legacy_key(&env, &caller, &token).into_val(&env);
        assert_eq!(actual.to_xdr(&env), expected.to_xdr(&env));
    }
}

#[test]
fn pre_upgrade_true_marker_is_rejected_without_repair_or_events() {
    let (env, contract, caller) = setup();
    let token = BytesN::from_array(&env, &[1; 32]);
    let key = legacy_key(&env, &caller, &token);
    env.as_contract(&contract, || env.storage().instance().set(&key, &true));
    env.mock_all_auths();
    let client = PredictifyHybridClient::new(&env, &contract);
    for _ in 0..2 {
        assert_eq!(
            client.try_place_bets(&caller, &bets(&env), &token),
            Err(Ok(Error::IdempotentBatchAlreadyApplied))
        );
    }
    env.as_contract(&contract, || {
        assert_eq!(env.storage().instance().get::<_, bool>(&key), Some(true))
    });
    assert!(env.events().all().is_empty());
}

#[test]
fn fresh_writes_remain_readable_by_legacy_clients_and_scoped_to_caller() {
    let (env, contract, caller) = setup();
    let token = BytesN::from_array(&env, &[255; 32]);
    env.mock_all_auths();
    let client = PredictifyHybridClient::new(&env, &contract);
    client.place_bets(&caller, &bets(&env), &token);
    env.as_contract(&contract, || {
        assert_eq!(
            env.storage()
                .instance()
                .get::<_, bool>(&legacy_key(&env, &caller, &token)),
            Some(true)
        )
    });
    assert_eq!(
        client.try_place_bets(&caller, &bets(&env), &token),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    client.place_bets(&Address::generate(&env), &bets(&env), &token);
    client.place_bets(&caller, &bets(&env), &BytesN::from_array(&env, &[2; 32]));
}

#[test]
fn malformed_markers_fail_closed_without_destroying_the_original_value() {
    let (env, contract, caller) = setup();
    let token = BytesN::from_array(&env, &[3; 32]);
    let key = legacy_key(&env, &caller, &token);
    let invalid: Vec<Val> = vec![
        &env,
        false.into_val(&env),
        0u32.into_val(&env),
        1u32.into_val(&env),
        Symbol::new(&env, "unknown").into_val(&env),
        Vec::<Val>::new(&env).into_val(&env),
    ];
    env.mock_all_auths();
    let client = PredictifyHybridClient::new(&env, &contract);
    for original in invalid.iter() {
        env.as_contract(&contract, || env.storage().instance().set(&key, &original));
        for _ in 0..2 {
            assert_eq!(
                client.try_place_bets(&caller, &bets(&env), &token),
                Err(Ok(Error::InvalidIdempotencyState))
            );
        }
        env.as_contract(&contract, || {
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, Val>(&key)
                    .unwrap()
                    .to_xdr(&env),
                original.to_xdr(&env)
            )
        });
    }
    assert!(env.events().all().is_empty());
}

#[test]
fn empty_batch_precedes_storage_validation_and_does_not_consume_a_fresh_key() {
    let (env, contract, caller) = setup();
    let token = BytesN::from_array(&env, &[4; 32]);
    env.mock_all_auths();
    let client = PredictifyHybridClient::new(&env, &contract);
    assert_eq!(
        client.try_place_bets(&caller, &Vec::new(&env), &token),
        Err(Ok(Error::EmptyBatch))
    );
    env.as_contract(&contract, || {
        assert!(!env
            .storage()
            .instance()
            .has(&legacy_key(&env, &caller, &token)))
    });
    client.place_bets(&caller, &bets(&env), &token);
    env.as_contract(&contract, || {
        env.storage()
            .instance()
            .set(&legacy_key(&env, &caller, &token), &false)
    });
    assert_eq!(
        client.try_place_bets(&caller, &Vec::new(&env), &token),
        Err(Ok(Error::EmptyBatch))
    );
}

#[test]
fn zero_token_retains_legacy_opt_out_even_with_an_existing_marker() {
    let (env, contract, caller) = setup();
    let zero = BytesN::from_array(&env, &[0; 32]);
    let key = legacy_key(&env, &caller, &zero);
    env.as_contract(&contract, || env.storage().instance().set(&key, &false));
    env.mock_all_auths();
    let client = PredictifyHybridClient::new(&env, &contract);
    client.place_bets(&caller, &bets(&env), &zero);
    client.place_bets(&caller, &bets(&env), &zero);
    env.as_contract(&contract, || {
        assert_eq!(env.storage().instance().get::<_, bool>(&key), Some(false))
    });
}

#[test]
fn unauthenticated_calls_cannot_consume_tokens() {
    let (env, contract, caller) = setup();
    let token = BytesN::from_array(&env, &[5; 32]);
    let client = PredictifyHybridClient::new(&env, &contract);
    assert!(client.try_place_bets(&caller, &bets(&env), &token).is_err());
    env.as_contract(&contract, || {
        assert!(!env
            .storage()
            .instance()
            .has(&legacy_key(&env, &caller, &token)))
    });
    env.mock_all_auths();
    client.place_bets(&caller, &bets(&env), &token);
}

#[test]
fn legacy_error_discriminants_remain_stable() {
    assert_eq!(Error::IdempotentBatchAlreadyApplied as u32, 1);
    assert_eq!(Error::EmptyBatch as u32, 2);
    // 3–5 are the released recovery vocabulary (InvalidAmount/BatchTooLarge/
    // AmountOverflow); this legacy-state error is an appended alias at 13.
    assert_eq!(Error::InvalidIdempotencyState as u32, 13);
}

#[test]
fn old_client_and_payload_still_succeed_and_decode_old_errors() {
    let (env, contract, caller) = setup();
    let client = LegacyClient::new(&env, &contract);
    let token = BytesN::from_array(&env, &[7; 32]);
    let legacy_bets = vec![
        &env,
        LegacyBet {
            market_id: u64::MAX,
            amount: i128::MAX,
        },
    ];
    env.mock_all_auths();
    client.place_bets(&caller, &legacy_bets, &token);
    assert_eq!(
        client.try_place_bets(&caller, &legacy_bets, &token),
        Err(Ok(LegacyError::IdempotentBatchAlreadyApplied))
    );
    assert_eq!(
        client.try_place_bets(&caller, &Vec::new(&env), &token),
        Err(Ok(LegacyError::EmptyBatch))
    );
    env.as_contract(&contract, || {
        env.storage()
            .instance()
            .set(&legacy_key(&env, &caller, &token), &false)
    });
    assert_eq!(
        client.try_place_bets(&caller, &legacy_bets, &token),
        Err(Err(soroban_sdk::InvokeError::Contract(13)))
    );
}

#[contract]
struct FailingLegacyBatch;

#[contractimpl]
impl FailingLegacyBatch {
    pub fn run(env: Env, caller: Address, token: BytesN<32>, fail: bool) -> Result<(), Error> {
        crate::bets::place_bets(&env, caller, bets(&env), token)?;
        if fail {
            Err(Error::EmptyBatch)
        } else {
            Ok(())
        }
    }
}

fn committed_events(env: &Env) -> usize {
    // Events::all also contains diagnostic copies from rolled-back SDK 21 calls.
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
fn downstream_failure_rolls_back_the_legacy_marker_and_retry_can_commit_once() {
    let (env, _, caller) = setup();
    let contract = env.register_contract(None, FailingLegacyBatch);
    let client = FailingLegacyBatchClient::new(&env, &contract);
    let token = BytesN::from_array(&env, &[6; 32]);
    let key = legacy_key(&env, &caller, &token);
    env.mock_all_auths();
    assert_eq!(
        client.try_run(&caller, &token, &true),
        Err(Ok(Error::EmptyBatch))
    );
    env.as_contract(&contract, || assert!(!env.storage().instance().has(&key)));
    assert_eq!(committed_events(&env), 0);
    client.run(&caller, &token, &false);
    assert_eq!(
        client.try_run(&caller, &token, &false),
        Err(Ok(Error::IdempotentBatchAlreadyApplied))
    );
    env.as_contract(&contract, || {
        assert_eq!(env.storage().instance().get::<_, bool>(&key), Some(true))
    });
    assert_eq!(committed_events(&env), 1);
}
