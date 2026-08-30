/**
 * @module milestones/divergence/compare
 * @description Pure, side-effect-free comparison of indexed vs on-chain
 *              milestone state.
 *
 * The functions in this module never perform I/O, never write state, and never
 * throw on malformed input (they degrade to a `divergent` comparison with an
 * explicit difference). Keeping comparison pure makes the field-level diff
 * deterministic and unit-testable without any fixtures.
 *
 * Determinism guarantees:
 *  - Milestones are compared keyed by `milestoneId` and the output is sorted
 *    by `milestoneId`, so identical inputs always produce identical outputs.
 *  - Only a fixed field set is compared (`title`, `description`, `amount`,
 *    `deadline`, `completed`), so new fields cannot silently change results.
 */

import type {
  ContractComparison,
  MilestoneComparison,
  MilestoneFieldDifference,
  MilestoneState,
} from './types';

/** Fields compared for each milestone, in canonical order. */
const COMPARED_FIELDS: ReadonlyArray<{
  field: string;
  get: (m: MilestoneState) => unknown;
}> = [
  { field: 'title', get: (m) => m.title },
  { field: 'description', get: (m) => m.description },
  { field: 'amount', get: (m) => m.amount },
  { field: 'deadline', get: (m) => m.deadline ?? null },
  { field: 'completed', get: (m) => m.completed },
];

/** Milestone ids present on-chain but missing from the indexed view. */
export interface MissingIndexedResult {
  milestoneId: string;
  onChain: MilestoneState;
}

/** Flattened field difference for a milestone that is missing on one side. */
function missingMilestoneDifference(
  milestoneId: string,
  indexed: MilestoneState | undefined,
  onChain: MilestoneState | undefined,
): MilestoneFieldDifference {
  return {
    field: `milestones.${milestoneId}`,
    indexed: indexed ?? null,
    onChain: onChain ?? null,
  };
}

/**
 * Compares two views of the same milestone field-by-field.
 *
 * @param indexed - Milestone as indexed by the backend.
 * @param onChain - Milestone as read from the chain.
 * @param milestoneId - Stable identifier used to key the comparison.
 * @returns Per-milestone comparison. `missing_indexed` / `missing_on_chain`
 *          are returned when exactly one side lacks the milestone.
 */
export function compareMilestone(
  indexed: MilestoneState | undefined,
  onChain: MilestoneState | undefined,
  milestoneId: string,
): MilestoneComparison {
  if (!indexed && !onChain) {
    return { milestoneId, status: 'in_sync', differences: [] };
  }
  if (!indexed) {
    return {
      milestoneId,
      status: 'missing_indexed',
      differences: [missingMilestoneDifference(milestoneId, undefined, onChain)],
    };
  }
  if (!onChain) {
    return {
      milestoneId,
      status: 'missing_on_chain',
      differences: [missingMilestoneDifference(milestoneId, indexed, undefined)],
    };
  }

  const differences: MilestoneFieldDifference[] = [];
  for (const { field, get } of COMPARED_FIELDS) {
    const a = get(indexed);
    const b = get(onChain);
    if (!valuesEqual(a, b)) {
      differences.push({
        field: `milestones.${milestoneId}.${field}`,
        indexed: a,
        onChain: b,
      });
    }
  }

  return {
    milestoneId,
    status: differences.length === 0 ? 'in_sync' : 'divergent',
    differences,
  };
}

/**
 * Compares every milestone of one contract across the two views.
 *
 * @param indexed - All indexed milestones for the contract.
 * @param onChain - All on-chain milestones for the contract.
 * @param context - contractId, tenantId and the block height the on-chain
 *                  view was read at.
 * @returns Contract-level comparison. `status` is `divergent` when any
 *          milestone differs or is missing on either side, `in_sync` only
 *          when both sides are identical, field-for-field.
 */
export function compareContract(
  indexed: MilestoneState[],
  onChain: MilestoneState[],
  context: {
    contractId: string;
    tenantId: string;
    blockHeight?: number;
    comparedAt?: string;
  },
): ContractComparison {
  const indexedById = new Map(indexed.map((m) => [m.milestoneId, m]));
  const onChainById = new Map(onChain.map((m) => [m.milestoneId, m]));

  // Union of ids, sorted for deterministic output.
  const allIds = Array.from(
    new Set([...indexedById.keys(), ...onChainById.keys()]),
  ).sort();

  const milestoneComparisons: MilestoneComparison[] = allIds.map((id) =>
    compareMilestone(indexedById.get(id), onChainById.get(id), id),
  );

  const missingIndexedMilestones = allIds.filter(
    (id) => !indexedById.has(id) && onChainById.has(id),
  );

  const differences = milestoneComparisons.flatMap((c) => c.differences);

  const status =
    differences.length > 0 ? 'divergent' : ('in_sync' as const);

  return {
    contractId: context.contractId,
    tenantId: context.tenantId,
    status,
    ...(context.blockHeight !== undefined && {
      blockHeight: context.blockHeight,
    }),
    comparedAt: context.comparedAt ?? new Date().toISOString(),
    milestoneComparisons,
    missingIndexedMilestones,
    differences,
  };
}

/**
 * Deep-ish equality for compared field values.
 *
 * Handles the value shapes that milestone fields take: strings, numbers,
 * booleans, null and undefined. `amount` is compared numerically so that a
 * string-encoded chain value (`"500"`) and an indexed number (`500`) are
 * treated as equal rather than spuriously divergent.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b;
  }
  if (typeof a === 'number' && typeof b === 'string') {
    return a === Number(b);
  }
  if (typeof b === 'number' && typeof a === 'string') {
    return b === Number(a);
  }
  return a === b;
}
