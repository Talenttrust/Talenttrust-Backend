//! # predictify-hybrid
//!
//! Soroban smart contract for prediction markets.
//!
//! ## Idempotency
//!
//! `place_bets` accepts a caller-supplied `BytesN<32>` idempotency key.
//! The key is stored in temporary storage under
//! `DataKey::PlaceBetsIdem(caller, key)` with an independent inclusive
//! deadline of acceptance ledger + [`storage::IDEM_KEY_TTL_LEDGERS`] (~24 h). Repeated
//! submissions with the same `(caller, key)` pair are rejected with
//! `Error::IdempotentBatchAlreadyApplied`.

#![no_std]

mod bets;
mod errors;
mod storage;

#[cfg(test)]
mod batch_operations_tests;
#[cfg(test)]
mod storage_tests;

pub use bets::{Bet, MAX_BETS_PER_BATCH};
pub use errors::Error;
pub use storage::{DataKey, IDEM_KEY_TTL_LEDGERS, IDEM_KEY_TTL_THRESHOLD_LEDGERS, MAX_BATCH_SIZE};

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec};

#[contract]
pub struct PredictifyHybrid;

#[contractimpl]
impl PredictifyHybrid {
    /// Submit a batch of bets atomically.
    ///
    /// See [`bets::place_bets`] for full documentation of the
    /// validation boundaries and failure modes.
    pub fn place_bets(
        env: Env,
        caller: Address,
        bets: Vec<Bet>,
        idempotency_key: BytesN<32>,
    ) -> Result<(), Error> {
        bets::place_bets(&env, caller, bets, idempotency_key)
    }
}
