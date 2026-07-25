import { z } from 'zod';

// Hard-coded policy decision: these values are not governed on-chain.
// They are enforced at the API layer to prevent griefing and cap worst-case
// resource usage. Rationale: the Soroban escrow contract stores milestones in
// a Vec bounded by host memory limits, and Stellar stroops are u64 — picking
// values well below u64::MAX prevents overflow in downstream contract calls.
// Change via code review; no runtime toggle to avoid misconfiguration risk.
export const MAX_MILESTONES_PER_CONTRACT = 20;
export const MAX_CONTRACT_AMOUNT_STROOPS = 100_000_000_000_000; // 10 000 000 XLM
// Bounds free-text contract terms to a reasonable size, preventing oversized
// payloads (e.g. on dispute-triggering updates) from reaching the store.
export const MAX_CONTRACT_TERMS_LENGTH = 5000;

export interface ContractBounds {
  maxMilestonesPerContract: number;
  maxContractAmountStroops: number;
}

export const CONTRACT_BOUNDS: ContractBounds = {
  maxMilestonesPerContract: MAX_MILESTONES_PER_CONTRACT,
  maxContractAmountStroops: MAX_CONTRACT_AMOUNT_STROOPS,
};

export class ContractBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractBoundsError';
  }
}

export const milestoneSchema = z.object({
  title: z.string().min(1).max(200),
  amount: z.number().positive(),
});

export type Milestone = z.infer<typeof milestoneSchema>;

/**
 * Validates that the contract budget and milestones are within the allowed policy limits.
 * 
 * Enforces:
 * - Budget must not exceed MAX_CONTRACT_AMOUNT_STROOPS.
 * - Total amount of all milestones must not exceed MAX_CONTRACT_AMOUNT_STROOPS.
 * - Number of milestones must not exceed MAX_MILESTONES_PER_CONTRACT.
 * 
 * @param budget - The total contract budget in stroops.
 * @param milestones - Optional list of milestones to validate.
 * @returns An object indicating if the bounds are valid and an error message if not.
 */
export function validateContractBounds(
  budget: number,
  milestones?: Milestone[],
): { valid: true } | { valid: false; error: string } {
  if (budget > MAX_CONTRACT_AMOUNT_STROOPS) {
    return {
      valid: false,
      error: `Budget exceeds maximum contract amount of ${MAX_CONTRACT_AMOUNT_STROOPS} stroops`,
    };
  }

  if (milestones !== undefined) {
    if (milestones.length > MAX_MILESTONES_PER_CONTRACT) {
      return {
        valid: false,
        error: `Milestone count ${milestones.length} exceeds maximum of ${MAX_MILESTONES_PER_CONTRACT}`,
      };
    }

    let total = 0;
    for (const m of milestones) {
      total += m.amount;
      if (!Number.isFinite(total) || total > MAX_CONTRACT_AMOUNT_STROOPS) {
        return {
          valid: false,
          error: `Total milestone amount exceeds maximum contract amount of ${MAX_CONTRACT_AMOUNT_STROOPS} stroops`,
        };
      }
    }
  }

  return { valid: true };
}
