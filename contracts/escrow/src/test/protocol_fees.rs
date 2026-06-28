//! Unit and integration tests for protocol-fee deduction in `release_milestone`.
//!
//! Covers:
//! - Zero fee rate: freelancer receives the full gross amount.
//! - Non-zero fee rate: freelancer receives net, protocol retains fee.
//! - Multi-release: invariant holds across sequential releases.
//! - Invariant: released + refunded + fees <= funded after every operation.
//! - Edge: release exactly the available balance (full drain).
//! - Error paths: insufficient balance, zero amount.

#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};

    use crate::{calculate_protocol_fee, available_balance, Escrow, EscrowClient, Error};

    // ── helpers ──────────────────────────────────────────────────────────────

    fn setup(fee_bps: u32, funded: i128) -> (Env, EscrowClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(Escrow, ());
        // SAFETY: the client borrows env; we keep env alive for the test.
        let client = EscrowClient::new(&env, &contract_id);
        let client: EscrowClient<'static> = unsafe { core::mem::transmute(client) };
        let env: Env = unsafe { core::mem::transmute(env) };
        let _ = &env; // suppress move-after-transmute warning
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        client
            .initialize(&client_addr, &freelancer, &funded, &fee_bps)
            .unwrap();
        (env, client, client_addr, freelancer)
    }

    // Simpler helper that avoids the transmute dance — use this for most tests.
    fn make(fee_bps: u32, funded: i128) -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(Escrow, ());
        let client = EscrowClient::new(&env, &contract_id);
        let ca = Address::generate(&env);
        let fr = Address::generate(&env);
        client.initialize(&ca, &fr, &funded, &fee_bps).unwrap();
        (env, ca, fr)
    }

    fn client(env: &Env) -> EscrowClient {
        // Re-register would clash; find the existing one.
        // For tests we re-create by registering fresh — simpler per test.
        unreachable!("use per-test env pattern")
    }

    // Per-test pattern: env + contract_id kept together.
    struct Ctx {
        env: Env,
        contract_id: soroban_sdk::Address,
        client_addr: Address,
        freelancer: Address,
    }

    impl Ctx {
        fn new(fee_bps: u32, funded: i128) -> Self {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register(Escrow, ());
            let client = EscrowClient::new(&env, &contract_id);
            let client_addr = Address::generate(&env);
            let freelancer = Address::generate(&env);
            client
                .initialize(&client_addr, &freelancer, &funded, &fee_bps)
                .unwrap();
            Ctx { env, contract_id, client_addr, freelancer }
        }

        fn client(&self) -> EscrowClient {
            EscrowClient::new(&self.env, &self.contract_id)
        }
    }

    // ── calculate_protocol_fee unit tests ────────────────────────────────────

    #[test]
    fn fee_zero_bps_returns_zero() {
        assert_eq!(calculate_protocol_fee(1_000_000, 0), 0);
    }

    #[test]
    fn fee_100_bps_is_one_percent() {
        assert_eq!(calculate_protocol_fee(1_000, 100), 10);
    }

    #[test]
    fn fee_floors_fractional_stroops() {
        // 1 stroop at 100 bps: 1 * 100 / 10_000 = 0 (floor)
        assert_eq!(calculate_protocol_fee(1, 100), 0);
        // 99 stroops at 100 bps: 99 * 100 / 10_000 = 0 (floor)
        assert_eq!(calculate_protocol_fee(99, 100), 0);
        // 100 stroops at 100 bps: 100 * 100 / 10_000 = 1
        assert_eq!(calculate_protocol_fee(100, 100), 1);
    }

    #[test]
    fn fee_5000_bps_is_fifty_percent() {
        assert_eq!(calculate_protocol_fee(1_000, 5_000), 500);
    }

    // ── zero-fee release ──────────────────────────────────────────────────────

    #[test]
    fn zero_fee_freelancer_receives_gross_amount() {
        let ctx = Ctx::new(0, 10_000);
        ctx.client()
            .release_milestone(&ctx.client_addr, &10_000)
            .unwrap();
        let state = ctx.client().get_state().unwrap();
        assert_eq!(state.released_amount, 10_000, "net == gross when fee is 0");
        assert_eq!(state.accumulated_fees, 0);
        assert_eq!(
            state.released_amount + state.refunded_amount + state.accumulated_fees,
            state.funded_amount
        );
    }

    // ── non-zero-fee release ──────────────────────────────────────────────────

    #[test]
    fn nonzero_fee_freelancer_receives_net() {
        // 1 % fee on 10_000 → fee=100, net=9_900
        let ctx = Ctx::new(100, 10_000);
        ctx.client()
            .release_milestone(&ctx.client_addr, &10_000)
            .unwrap();
        let state = ctx.client().get_state().unwrap();
        assert_eq!(state.released_amount, 9_900);
        assert_eq!(state.accumulated_fees, 100);
        // invariant
        assert!(
            state.released_amount + state.refunded_amount + state.accumulated_fees
                <= state.funded_amount
        );
    }

    #[test]
    fn net_plus_fee_equals_gross_milestone() {
        let ctx = Ctx::new(250, 8_000); // 2.5 %
        ctx.client()
            .release_milestone(&ctx.client_addr, &8_000)
            .unwrap();
        let state = ctx.client().get_state().unwrap();
        // net + fee must equal the gross milestone amount
        assert_eq!(state.released_amount + state.accumulated_fees, 8_000);
    }

    // ── multi-release accounting ──────────────────────────────────────────────

    #[test]
    fn multi_release_invariant_holds_after_each_step() {
        let ctx = Ctx::new(100, 30_000); // 1 %
        for milestone in [10_000_i128, 10_000, 10_000] {
            ctx.client()
                .release_milestone(&ctx.client_addr, &milestone)
                .unwrap();
            let s = ctx.client().get_state().unwrap();
            assert!(
                s.released_amount + s.refunded_amount + s.accumulated_fees <= s.funded_amount,
                "invariant violated after release of {milestone}"
            );
        }
        let s = ctx.client().get_state().unwrap();
        // 3 × 10_000 at 1 % → 3 × fee=100, 3 × net=9_900
        assert_eq!(s.released_amount, 29_700);
        assert_eq!(s.accumulated_fees, 300);
    }

    #[test]
    fn release_then_refund_invariant_holds() {
        let ctx = Ctx::new(200, 20_000); // 2 %
        // Release half
        ctx.client()
            .release_milestone(&ctx.client_addr, &10_000)
            .unwrap();
        // Refund the remainder
        let s = ctx.client().get_state().unwrap();
        let avail = available_balance(&s);
        ctx.client().refund(&ctx.client_addr, &avail).unwrap();
        let s = ctx.client().get_state().unwrap();
        assert!(
            s.released_amount + s.refunded_amount + s.accumulated_fees <= s.funded_amount,
            "invariant violated after release + refund"
        );
    }

    // ── full-drain edge case ──────────────────────────────────────────────────

    #[test]
    fn release_exactly_available_balance_accepted() {
        let ctx = Ctx::new(500, 10_000); // 5 %
        // available = 10_000; releasing 10_000 leaves net=9_500, fee=500
        ctx.client()
            .release_milestone(&ctx.client_addr, &10_000)
            .unwrap();
        let s = ctx.client().get_state().unwrap();
        assert_eq!(available_balance(&s), 0);
    }

    // ── error paths ───────────────────────────────────────────────────────────

    #[test]
    fn release_zero_amount_returns_error() {
        let ctx = Ctx::new(100, 10_000);
        let result = ctx.client().try_release_milestone(&ctx.client_addr, &0);
        assert_eq!(result, Err(Ok(Error::ZeroAmount)));
    }

    #[test]
    fn release_exceeds_available_returns_insufficient_balance() {
        let ctx = Ctx::new(100, 10_000);
        let result = ctx
            .client()
            .try_release_milestone(&ctx.client_addr, &10_001);
        assert_eq!(result, Err(Ok(Error::InsufficientBalance)));
    }

    #[test]
    fn release_after_full_drain_returns_insufficient_balance() {
        let ctx = Ctx::new(0, 5_000);
        ctx.client()
            .release_milestone(&ctx.client_addr, &5_000)
            .unwrap();
        let result = ctx.client().try_release_milestone(&ctx.client_addr, &1);
        assert_eq!(result, Err(Ok(Error::InsufficientBalance)));
    }

    #[test]
    fn fee_too_high_rejected_at_init() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(Escrow, ());
        let c = EscrowClient::new(&env, &id);
        let ca = Address::generate(&env);
        let fr = Address::generate(&env);
        let result = c.try_initialize(&ca, &fr, &10_000, &5_001);
        assert_eq!(result, Err(Ok(Error::FeeTooHigh)));
    }
}
