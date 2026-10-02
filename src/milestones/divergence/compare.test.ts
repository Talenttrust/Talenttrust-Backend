/**
 * Milestone divergence comparison tests.
 *
 * Covers the issue's comparison edge cases at the pure-logic level:
 *  - no differences           → `in_sync`
 *  - one field differs        → `divergent` with a field-level difference
 *  - missing indexed record   → `missing_indexed` + contract `divergent`
 *  - missing on-chain record  → `missing_on_chain`
 *  - empty contract           → `in_sync`
 *  - deterministic ordering   → output sorted by milestoneId
 *  - amount string/number     → numerically equal (not spuriously divergent)
 */

import { compareContract, compareMilestone } from './compare';
import type { MilestoneState } from './types';

function makeMilestone(overrides: Partial<MilestoneState> = {}): MilestoneState {
  return {
    milestoneId: 'm1',
    title: 'Design review',
    description: 'Review the design doc',
    amount: 500,
    completed: false,
    ...overrides,
  };
}

const CONTEXT = {
  contractId: 'contract-1',
  tenantId: 'tenant-a',
  blockHeight: 12345,
  comparedAt: '2026-01-01T00:00:00.000Z',
};

describe('compareMilestone', () => {
  it('reports in_sync when both views match exactly', () => {
    const result = compareMilestone(makeMilestone(), makeMilestone(), 'm1');
    expect(result.status).toBe('in_sync');
    expect(result.differences).toHaveLength(0);
  });

  it('reports one field difference with indexed/onChain values', () => {
    const result = compareMilestone(
      makeMilestone({ amount: 500 }),
      makeMilestone({ amount: 900 }),
      'm1',
    );
    expect(result.status).toBe('divergent');
    expect(result.differences).toEqual([
      {
        field: 'milestones.m1.amount',
        indexed: 500,
        onChain: 900,
      },
    ]);
  });

  it('reports missing_indexed when only the chain has the milestone', () => {
    const result = compareMilestone(undefined, makeMilestone(), 'm1');
    expect(result.status).toBe('missing_indexed');
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]!.field).toBe('milestones.m1');
    expect(result.differences[0]!.indexed).toBeNull();
    expect(result.differences[0]!.onChain).toEqual(makeMilestone());
  });

  it('reports missing_on_chain when only the index has the milestone', () => {
    const result = compareMilestone(makeMilestone(), undefined, 'm1');
    expect(result.status).toBe('missing_on_chain');
    expect(result.differences[0]!.onChain).toBeNull();
  });

  it('treats a numerically-encoded chain amount as equal to a number', () => {
    const result = compareMilestone(
      makeMilestone({ amount: 500 }),
      makeMilestone({ amount: '500' }),
      'm1',
    );
    expect(result.status).toBe('in_sync');
  });

  it('flags a genuinely different string amount as divergent', () => {
    const result = compareMilestone(
      makeMilestone({ amount: 500 }),
      makeMilestone({ amount: 'not-a-number' }),
      'm1',
    );
    expect(result.status).toBe('divergent');
  });
});

describe('compareContract', () => {
  it('reports in_sync when every milestone matches', () => {
    const indexed = [makeMilestone({ milestoneId: 'm1' }), makeMilestone({ milestoneId: 'm2' })];
    const onChain = [makeMilestone({ milestoneId: 'm1' }), makeMilestone({ milestoneId: 'm2' })];
    const result = compareContract(indexed, onChain, CONTEXT);
    expect(result.status).toBe('in_sync');
    expect(result.blockHeight).toBe(12345);
    expect(result.differences).toHaveLength(0);
    expect(result.missingIndexedMilestones).toHaveLength(0);
  });

  it('reports divergent when a single field differs', () => {
    const result = compareContract(
      [makeMilestone({ milestoneId: 'm1', title: 'A' })],
      [makeMilestone({ milestoneId: 'm1', title: 'B' })],
      CONTEXT,
    );
    expect(result.status).toBe('divergent');
    expect(result.differences).toEqual([
      {
        field: 'milestones.m1.title',
        indexed: 'A',
        onChain: 'B',
      },
    ]);
    expect(result.milestoneComparisons[0]!.status).toBe('divergent');
  });

  it('reports divergent and lists the milestone when the indexed record is missing', () => {
    const result = compareContract([], [makeMilestone({ milestoneId: 'm1' })], CONTEXT);
    expect(result.status).toBe('divergent');
    expect(result.missingIndexedMilestones).toEqual(['m1']);
    expect(result.milestoneComparisons[0]!.status).toBe('missing_indexed');
    expect(result.differences[0]!.field).toBe('milestones.m1');
  });

  it('reports divergent when the on-chain record is missing', () => {
    const result = compareContract([makeMilestone({ milestoneId: 'm1' })], [], CONTEXT);
    expect(result.status).toBe('divergent');
    expect(result.milestoneComparisons[0]!.status).toBe('missing_on_chain');
  });

  it('treats an empty contract with no milestones on either side as in_sync', () => {
    const result = compareContract([], [], CONTEXT);
    expect(result.status).toBe('in_sync');
    expect(result.milestoneComparisons).toHaveLength(0);
  });

  it('sorts milestone comparisons deterministically by milestoneId', () => {
    const indexed = [
      makeMilestone({ milestoneId: 'z', completed: true }),
      makeMilestone({ milestoneId: 'a' }),
    ];
    const onChain = [
      makeMilestone({ milestoneId: 'z', completed: false }),
      makeMilestone({ milestoneId: 'a' }),
    ];
    const result = compareContract(indexed, onChain, CONTEXT);
    expect(result.milestoneComparisons.map((m) => m.milestoneId)).toEqual(['a', 'z']);
  });

  it('combines multiple differences across milestones into one flattened list', () => {
    const indexed = [
      makeMilestone({ milestoneId: 'm1', amount: 1 }),
      makeMilestone({ milestoneId: 'm2', title: 'T' }),
    ];
    const onChain = [
      makeMilestone({ milestoneId: 'm1', amount: 2 }),
      makeMilestone({ milestoneId: 'm2', title: 'U' }),
    ];
    const result = compareContract(indexed, onChain, CONTEXT);
    expect(result.status).toBe('divergent');
    expect(result.differences).toHaveLength(2);
    expect(result.differences.map((d) => d.field)).toEqual([
      'milestones.m1.amount',
      'milestones.m2.title',
    ]);
  });
});
