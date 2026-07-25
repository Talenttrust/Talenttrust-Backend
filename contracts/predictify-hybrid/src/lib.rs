//! # predictify-hybrid
//!
//! Soroban smart contract for prediction markets.
//!
//! ## Idempotency
//!
//! `place_bets` accepts a caller-supplied `BytesN<32>` idempotency key.
//! The key is stored in instance storage under
//! `DataKey::PlaceBetsIdem(caller, key)` with a TTL of
//! [`storage::IDEM_KEY_TTL_LEDGERS`] ledgers (~24 h).  Repeated
//! submissions with the same `(caller, key)` pair are rejected with
//! `Error::IdempotentBatchAlreadyApplied`.

#![no_std]

mod bets;
mod errors;
mod storage;

pub use bets::Bet;
pub use errors::Error;
pub use storage::{DataKey, IDEM_KEY_TTL_LEDGERS};

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec};

#[contract]
pub struct PredictifyHybrid;

#[contractimpl]
impl PredictifyHybrid {
    /// Submit a batch of bets atomically.
    ///
    /// See [`bets::place_bets`] for full documentation.
    pub fn place_bets(
        env: Env,
        caller: Address,
        bets: Vec<Bet>,
        idempotency_key: BytesN<32>,
    ) -> Result<(), Error> {
        bets::place_bets(&env, caller, bets, idempotency_key)
    }
}
