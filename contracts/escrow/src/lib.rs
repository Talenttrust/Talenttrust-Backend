//! # Escrow Contract
//!
//! Soroban smart contract for milestone-based freelancer escrow.
//!
//! ## Fee accounting model
//!
//! Every milestone release deducts the protocol fee **from the payout**:
//!
//! ```text
//! fee  = floor(amount × fee_bps / 10_000)
//! net  = amount − fee          ← transferred to freelancer
//! ```
//!
//! Storage is updated atomically:
//!
//! ```text
//! released_amount  += net      (what the freelancer actually received)
//! accumulated_fees += fee      (what the protocol retained)
//! ```
//!
//! The accounting invariant that must hold at all times:
//!
//! ```text
//! released_amount + refunded_amount + accumulated_fees <= funded_amount
//! ```
//!
//! This prevents double-counting: the fee is carved out of the payout, not
//! added on top of it.

#![no_std]

mod test;

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

// ── constants ────────────────────────────────────────────────────────────────

/// Maximum allowed fee in basis points (50 % = 5 000 bps).
pub const MAX_FEE_BPS: u32 = 5_000;

// ── errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// Caller is not the contract admin.
    Unauthorized = 1,
    /// Escrow has not been funded.
    NotFunded = 2,
    /// Milestone amount exceeds available escrow balance.
    InsufficientBalance = 3,
    /// fee_bps exceeds MAX_FEE_BPS.
    FeeTooHigh = 4,
    /// Accounting invariant violated (should never happen; indicates a bug).
    InvariantViolation = 5,
    /// Milestone amount is zero.
    ZeroAmount = 6,
}

// ── storage types ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowState {
    /// Client address that funded the escrow.
    pub client: Address,
    /// Freelancer address that receives net payouts.
    pub freelancer: Address,
    /// Total amount deposited by the client (gross).
    pub funded_amount: i128,
    /// Sum of net amounts paid out to the freelancer so far.
    pub released_amount: i128,
    /// Sum of gross amounts refunded to the client so far.
    pub refunded_amount: i128,
    /// Sum of fees retained by the protocol so far.
    pub accumulated_fees: i128,
    /// Protocol fee rate in basis points (0–5 000).
    pub fee_bps: u32,
}

#[contracttype]
pub enum DataKey {
    Escrow,
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Compute the protocol fee for `amount` at `fee_bps` basis points.
///
/// Uses integer floor division — no floating point, no `unwrap`.
///
/// # Examples
///
/// ```text
/// calculate_protocol_fee(1_000, 100)  // 1 % → 10
/// calculate_protocol_fee(1_000, 0)    // 0 % → 0
/// ```
pub fn calculate_protocol_fee(amount: i128, fee_bps: u32) -> i128 {
    amount * (fee_bps as i128) / 10_000
}

/// Return the amount of escrow balance still available for release or refund.
///
/// ```text
/// available = funded − released − refunded − accumulated_fees
/// ```
pub fn available_balance(state: &EscrowState) -> i128 {
    state.funded_amount
        - state.released_amount
        - state.refunded_amount
        - state.accumulated_fees
}

/// Assert the accounting invariant.  Panics with [`Error::InvariantViolation`]
/// if the invariant is broken — this indicates a contract bug.
fn assert_invariant(state: &EscrowState) -> Result<(), Error> {
    if state.released_amount + state.refunded_amount + state.accumulated_fees
        > state.funded_amount
    {
        return Err(Error::InvariantViolation);
    }
    Ok(())
}

// ── contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct Escrow;

#[contractimpl]
impl Escrow {
    /// Initialise the escrow.
    ///
    /// Must be called once by the client before any milestone release.
    ///
    /// # Parameters
    /// - `client`     – funds the escrow and may request refunds.
    /// - `freelancer` – receives net milestone payouts.
    /// - `amount`     – total gross amount deposited.
    /// - `fee_bps`    – protocol fee in basis points (0–5 000).
    pub fn initialize(
        env: Env,
        client: Address,
        freelancer: Address,
        amount: i128,
        fee_bps: u32,
    ) -> Result<(), Error> {
        client.require_auth();
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        let state = EscrowState {
            client,
            freelancer,
            funded_amount: amount,
            released_amount: 0,
            refunded_amount: 0,
            accumulated_fees: 0,
            fee_bps,
        };
        env.storage().instance().set(&DataKey::Escrow, &state);
        Ok(())
    }

    /// Release a milestone payout to the freelancer.
    ///
    /// ## Fee deduction
    ///
    /// The protocol fee is carved out of `amount` **before** crediting the
    /// freelancer:
    ///
    /// ```text
    /// fee              = floor(amount × fee_bps / 10_000)
    /// net_to_freelancer = amount − fee
    /// ```
    ///
    /// Storage updates (all atomic):
    ///
    /// ```text
    /// released_amount  += net_to_freelancer
    /// accumulated_fees += fee
    /// ```
    ///
    /// Invariant enforced after every release:
    ///
    /// ```text
    /// released_amount + refunded_amount + accumulated_fees <= funded_amount
    /// ```
    ///
    /// # Errors
    ///
    /// - [`Error::Unauthorized`]        – caller is not the client.
    /// - [`Error::NotFunded`]           – escrow not initialised.
    /// - [`Error::ZeroAmount`]          – `amount` is zero.
    /// - [`Error::InsufficientBalance`] – `amount` exceeds available balance.
    /// - [`Error::InvariantViolation`]  – accounting invariant broken (bug).
    pub fn release_milestone(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();

        let mut state: EscrowState = env
            .storage()
            .instance()
            .get(&DataKey::Escrow)
            .ok_or(Error::NotFunded)?;

        if caller != state.client {
            return Err(Error::Unauthorized);
        }
        if amount == 0 {
            return Err(Error::ZeroAmount);
        }
        if amount > available_balance(&state) {
            return Err(Error::InsufficientBalance);
        }

        // ── fee deduction ────────────────────────────────────────────────────
        // fee  = floor(amount × fee_bps / 10_000)
        // net  = amount − fee   ← what the freelancer receives
        //
        // released_amount tracks *net* payouts; accumulated_fees tracks the
        // protocol's share.  Together they must not exceed funded_amount.
        let fee = calculate_protocol_fee(amount, state.fee_bps);
        let net = amount - fee;

        state.released_amount += net;
        state.accumulated_fees += fee;

        // ── invariant check ──────────────────────────────────────────────────
        assert_invariant(&state)?;

        env.storage().instance().set(&DataKey::Escrow, &state);
        Ok(())
    }

    /// Refund `amount` of the escrow balance back to the client.
    pub fn refund(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();

        let mut state: EscrowState = env
            .storage()
            .instance()
            .get(&DataKey::Escrow)
            .ok_or(Error::NotFunded)?;

        if caller != state.client {
            return Err(Error::Unauthorized);
        }
        if amount == 0 {
            return Err(Error::ZeroAmount);
        }
        if amount > available_balance(&state) {
            return Err(Error::InsufficientBalance);
        }

        state.refunded_amount += amount;
        assert_invariant(&state)?;

        env.storage().instance().set(&DataKey::Escrow, &state);
        Ok(())
    }

    /// Read the current escrow state.
    pub fn get_state(env: Env) -> Result<EscrowState, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Escrow)
            .ok_or(Error::NotFunded)
    }
}
