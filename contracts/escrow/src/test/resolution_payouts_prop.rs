//! Property-based tests for `release_milestone` payout accounting.
//!
//! These tests drive sequences of milestone releases with varying amounts and
//! fee rates, then assert that the accounting invariant holds after every step:
//!
//! ```text
//! released_amount + refunded_amount + accumulated_fees <= funded_amount
//! ```
//!
//! They also verify that the sum of all net payouts plus all accumulated fees
//! equals the sum of all gross milestone amounts (conservation of value).

#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};

    use crate::{available_balance, calculate_protocol_fee, Escrow, EscrowClient};

    struct Ctx {
        env: Env,
        contract_id: soroban_sdk::Address,
        client_addr: Address,
    }

    impl Ctx {
        fn new(fee_bps: u32, funded: i128) -> Self {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register(Escrow, ());
            let c = EscrowClient::new(&env, &contract_id);
            let client_addr = Address::generate(&env);
            let freelancer = Address::generate(&env);
            c.initialize(&client_addr, &freelancer, &funded, &fee_bps)
                .unwrap();
            Ctx { env, contract_id, client_addr }
        }

        fn client(&self) -> EscrowClient {
            EscrowClient::new(&self.env, &self.contract_id)
        }
    }

    /// Drive a fixed sequence of milestones and verify the invariant holds
    /// after each release, then verify conservation of value at the end.
    fn run_sequence(fee_bps: u32, funded: i128, milestones: &[i128]) {
        let ctx = Ctx::new(fee_bps, funded);
        let mut total_net = 0_i128;
        let mut total_fees = 0_i128;

        for &m in milestones {
            ctx.client()
                .release_milestone(&ctx.client_addr, &m)
                .unwrap();

            let s = ctx.client().get_state().unwrap();
            assert!(
                s.released_amount + s.refunded_amount + s.accumulated_fees <= s.funded_amount,
                "invariant violated after releasing {m} (fee_bps={fee_bps})"
            );

            let fee = calculate_protocol_fee(m, fee_bps);
            total_net += m - fee;
            total_fees += fee;
        }

        let s = ctx.client().get_state().unwrap();
        assert_eq!(s.released_amount, total_net, "released_amount tracks net payouts");
        assert_eq!(
            s.accumulated_fees, total_fees,
            "accumulated_fees tracks protocol share"
        );
        // Conservation: net + fees == sum of gross milestones
        assert_eq!(
            s.released_amount + s.accumulated_fees,
            milestones.iter().sum::<i128>(),
            "net + fees must equal sum of gross milestones"
        );
    }

    // ── property 1: single release at various fee rates ───────────────────────

    #[test]
    fn prop_single_release_zero_fee() {
        run_sequence(0, 100_000, &[100_000]);
    }

    #[test]
    fn prop_single_release_low_fee() {
        run_sequence(50, 100_000, &[100_000]); // 0.5 %
    }

    #[test]
    fn prop_single_release_mid_fee() {
        run_sequence(1_000, 100_000, &[100_000]); // 10 %
    }

    #[test]
    fn prop_single_release_max_fee() {
        run_sequence(5_000, 100_000, &[100_000]); // 50 %
    }

    // ── property 2: equal milestone splits ───────────────────────────────────

    #[test]
    fn prop_four_equal_milestones_zero_fee() {
        run_sequence(0, 40_000, &[10_000, 10_000, 10_000, 10_000]);
    }

    #[test]
    fn prop_four_equal_milestones_100bps() {
        run_sequence(100, 40_000, &[10_000, 10_000, 10_000, 10_000]);
    }

    #[test]
    fn prop_four_equal_milestones_500bps() {
        run_sequence(500, 40_000, &[10_000, 10_000, 10_000, 10_000]);
    }

    // ── property 3: unequal milestone splits ─────────────────────────────────

    #[test]
    fn prop_unequal_milestones_100bps() {
        run_sequence(100, 50_000, &[5_000, 15_000, 30_000]);
    }

    #[test]
    fn prop_unequal_milestones_300bps() {
        run_sequence(300, 50_000, &[1_000, 9_000, 15_000, 25_000]);
    }

    // ── property 4: single-stroop milestones (floor division edge) ────────────

    #[test]
    fn prop_single_stroop_milestones_100bps() {
        // 100 bps on 1 stroop → fee=0, net=1; invariant must still hold
        run_sequence(100, 100, &[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    }

    #[test]
    fn prop_single_stroop_milestones_5000bps() {
        // 5000 bps on 1 stroop: 1 * 5000 / 10000 = 0 (floor)
        run_sequence(5_000, 10, &[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    }

    // ── property 5: available_balance never goes negative ─────────────────────

    #[test]
    fn prop_available_balance_non_negative_throughout() {
        let fee_bps = 200_u32; // 2 %
        let funded = 60_000_i128;
        let milestones = [10_000_i128, 20_000, 5_000, 5_000];

        let ctx = Ctx::new(fee_bps, funded);
        for &m in &milestones {
            ctx.client()
                .release_milestone(&ctx.client_addr, &m)
                .unwrap();
            let s = ctx.client().get_state().unwrap();
            assert!(
                available_balance(&s) >= 0,
                "available_balance went negative after releasing {m}"
            );
        }
    }

    // ── property 6: mix of releases and refunds ───────────────────────────────

    #[test]
    fn prop_release_and_refund_invariant() {
        let funded = 100_000_i128;
        let ctx = Ctx::new(100, funded); // 1 %

        ctx.client()
            .release_milestone(&ctx.client_addr, &30_000)
            .unwrap();
        ctx.client().refund(&ctx.client_addr, &20_000).unwrap();
        ctx.client()
            .release_milestone(&ctx.client_addr, &10_000)
            .unwrap();

        let s = ctx.client().get_state().unwrap();
        assert!(
            s.released_amount + s.refunded_amount + s.accumulated_fees <= s.funded_amount,
            "invariant violated after mix of release + refund"
        );
        // Conservation for the released portion only
        let gross_released = 30_000 + 10_000;
        assert_eq!(
            s.released_amount + s.accumulated_fees,
            gross_released,
            "net + fees must equal sum of gross milestones"
        );
    }

    // ── property 7: exhaustive fee rates 0..=5000 on a fixed amount ───────────

    #[test]
    fn prop_all_fee_rates_satisfy_invariant() {
        // Spot-check every 500 bps increment to keep the test fast.
        for bps in (0_u32..=5_000).step_by(500) {
            run_sequence(bps, 100_000, &[100_000]);
        }
    }
}
