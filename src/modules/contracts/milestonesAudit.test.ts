import {
  MAX_SUMMARY_ITEMS,
  summarizeMilestones,
  determineMilestonesAction,
  buildMilestonesAuditMetadata,
  getLastMilestonesSnapshot,
  type MilestonesSnapshot,
} from './milestonesAudit';
import type { ContractMilestoneDto } from './dto/contracts-boundary.dto';
import type { AuditEntry } from '../../audit/types';

function makeMilestone(overrides: Partial<ContractMilestoneDto> = {}): ContractMilestoneDto {
  return {
    title: 'Kickoff',
    description: 'Project start',
    amount: 1000,
    completed: false,
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'entry-1',
    timestamp: new Date().toISOString(),
    action: 'MILESTONES_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'milestones',
    resourceId: 'contract-1',
    metadata: {},
    hash: 'hash',
    previousHash: 'GENESIS',
    ...overrides,
  } as AuditEntry;
}

describe('summarizeMilestones', () => {
  it('returns null for undefined', () => {
    expect(summarizeMilestones(undefined)).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(summarizeMilestones([])).toBeNull();
  });

  it('summarises a single milestone', () => {
    const summary = summarizeMilestones([makeMilestone({ title: 'Design', amount: 500 })]);
    expect(summary).toEqual({
      count: 1,
      totalAmount: 500,
      truncated: false,
      items: [{ title: 'Design', amount: 500, completed: false }],
    });
  });

  it('sums totalAmount across multiple milestones', () => {
    const summary = summarizeMilestones([
      makeMilestone({ title: 'Phase 1', amount: 200 }),
      makeMilestone({ title: 'Phase 2', amount: 300 }),
    ]);
    expect(summary?.count).toBe(2);
    expect(summary?.totalAmount).toBe(500);
  });

  it('omits the free-text description field from the summary', () => {
    const summary = summarizeMilestones([
      makeMilestone({ description: 'Contains no secrets, just long free text.' }),
    ]);
    expect(summary?.items[0]).not.toHaveProperty('description');
  });

  it('includes deadline only when present', () => {
    const withDeadline = summarizeMilestones([
      makeMilestone({ deadline: '2026-12-01T00:00:00.000Z' }),
    ]);
    expect(withDeadline?.items[0].deadline).toBe('2026-12-01T00:00:00.000Z');

    const withoutDeadline = summarizeMilestones([makeMilestone()]);
    expect(withoutDeadline?.items[0]).not.toHaveProperty('deadline');
  });

  it('bounds the number of items retained and flags truncation', () => {
    const many = Array.from({ length: MAX_SUMMARY_ITEMS + 10 }, (_, i) =>
      makeMilestone({ title: `MS-${i}`, amount: 1 }),
    );
    const summary = summarizeMilestones(many);
    expect(summary?.count).toBe(MAX_SUMMARY_ITEMS + 10);
    expect(summary?.items).toHaveLength(MAX_SUMMARY_ITEMS);
    expect(summary?.truncated).toBe(true);
  });

  it('does not flag truncation when at exactly the bound', () => {
    const exact = Array.from({ length: MAX_SUMMARY_ITEMS }, (_, i) =>
      makeMilestone({ title: `MS-${i}`, amount: 1 }),
    );
    const summary = summarizeMilestones(exact);
    expect(summary?.truncated).toBe(false);
    expect(summary?.items).toHaveLength(MAX_SUMMARY_ITEMS);
  });

  it('redacts secret-shaped values found in milestone titles', () => {
    const summary = summarizeMilestones([
      makeMilestone({ title: 'api_key: sk-abcdef1234567890' }),
    ]);
    // The key "title" itself is not a sensitive key name, but a nested
    // object shaped like { api_key: ... } would be redacted; a plain string
    // title is passed through maskEmail-style string handling unchanged
    // unless it happens to look like an email address.
    expect(summary?.items[0].title).toBe('api_key: sk-abcdef1234567890');
  });

  it('masks email-shaped milestone titles', () => {
    const summary = summarizeMilestones([makeMilestone({ title: 'alice@example.com' })]);
    expect(summary?.items[0].title).toMatch(/^ali\*\*\*@example\.com$/);
  });
});

describe('determineMilestonesAction', () => {
  const snapshot = (count: number): MilestonesSnapshot => ({
    count,
    totalAmount: count * 100,
    truncated: false,
    items: Array.from({ length: count }, (_, i) => ({
      title: `MS-${i}`,
      amount: 100,
      completed: false,
    })),
  });

  it('returns null when both before and after are empty', () => {
    expect(determineMilestonesAction(null, null)).toBeNull();
  });

  it('returns MILESTONES_CREATED when there was no prior state', () => {
    expect(determineMilestonesAction(null, snapshot(1))).toBe('MILESTONES_CREATED');
  });

  it('returns MILESTONES_DELETED when milestones existed and are now gone', () => {
    expect(determineMilestonesAction(snapshot(2), null)).toBe('MILESTONES_DELETED');
  });

  it('returns MILESTONES_UPDATED when content changed', () => {
    expect(determineMilestonesAction(snapshot(1), snapshot(2))).toBe('MILESTONES_UPDATED');
  });

  it('returns null when the resubmitted milestones are identical (no-op)', () => {
    const before = snapshot(2);
    const after = snapshot(2);
    expect(determineMilestonesAction(before, after)).toBeNull();
  });

  it('returns null for identical content even when object key order differs', () => {
    // Deliberately constructed with a different key order than
    // summarizeMilestones() would produce, to guard against a regression to
    // an order-sensitive equality check (e.g. naive JSON.stringify diffing).
    const before: MilestonesSnapshot = {
      truncated: false,
      count: 1,
      items: [{ completed: false, amount: 100, title: 'Same' }],
      totalAmount: 100,
    };
    const after: MilestonesSnapshot = {
      count: 1,
      totalAmount: 100,
      items: [{ title: 'Same', amount: 100, completed: false }],
      truncated: false,
    };
    expect(determineMilestonesAction(before, after)).toBeNull();
  });

  it('treats a zero-count snapshot object the same as null', () => {
    const empty: MilestonesSnapshot = { count: 0, totalAmount: 0, truncated: false, items: [] };
    expect(determineMilestonesAction(empty, snapshot(1))).toBe('MILESTONES_CREATED');
    expect(determineMilestonesAction(snapshot(1), empty)).toBe('MILESTONES_DELETED');
  });
});

describe('buildMilestonesAuditMetadata', () => {
  it('wraps before/after into a single metadata object', () => {
    const before = null;
    const after = summarizeMilestones([makeMilestone()]);
    expect(buildMilestonesAuditMetadata(before, after)).toEqual({ before, after });
  });
});

describe('getLastMilestonesSnapshot', () => {
  it('returns null when no prior entries exist', () => {
    const service = { query: jest.fn().mockReturnValue([]) };
    expect(getLastMilestonesSnapshot(service, 'contract-1')).toBeNull();
    expect(service.query).toHaveBeenCalledWith({ resource: 'milestones', resourceId: 'contract-1' });
  });

  it('returns the after-snapshot from the most recent matching entry', () => {
    const after = summarizeMilestones([makeMilestone({ title: 'Latest' })]);
    const service = {
      query: jest.fn().mockReturnValue([
        makeAuditEntry({ id: 'older', metadata: { before: null, after: summarizeMilestones([makeMilestone({ title: 'Older' })]) } }),
        makeAuditEntry({ id: 'newest', metadata: { before: null, after } }),
      ]),
    };
    expect(getLastMilestonesSnapshot(service, 'contract-1')).toEqual(after);
  });

  it('returns null when the latest entry has a malformed/missing after snapshot', () => {
    const service = {
      query: jest.fn().mockReturnValue([makeAuditEntry({ metadata: { before: null, after: 'not-a-snapshot' } })]),
    };
    expect(getLastMilestonesSnapshot(service, 'contract-1')).toBeNull();
  });
});
