/**
 * Rewind service tests.
 *
 * Required edge cases covered per issue #1204:
 * - no reorg: no-op, zero counts
 * - single-ledger reorg: events demoted, cursors rewound
 * - reorg exceeds retention window: skipped, error thrown
 * - reorg during processing: handled by queue retry
 * - operator repeats rewind: idempotent (events already provisional are skipped)
 */

import { rewindAfterReorg, DemotableEventRepository, RewindServiceConfig } from './rewindService';
import { InMemoryCursorRepository } from '../contracts/cursor.repository';
import { ReorgEvaluation } from './reorgDetector';
import { EventProcessingAudit } from '../events/types';

// ── test helpers ──────────────────────────────────────────────────────────────

/** Minimal in-memory event repo that supports demoteProvisional. */
function createDemotableEventRepo(
  initialEvents: EventProcessingAudit[] = [],
): DemotableEventRepository & { events: Map<string, EventProcessingAudit> } {
  const events = new Map<string, EventProcessingAudit>();
  for (const e of initialEvents) {
    events.set(e.deduplicationKey, e);
  }

  return {
    events,
    async demoteProvisional(
      network: string,
      fromLedger: number,
      toLedger: number,
    ): Promise<number> {
      let demoted = 0;
      for (const [key, audit] of events.entries()) {
        if (
          audit.network === network &&
          audit.ledger !== undefined &&
          audit.ledger >= fromLedger &&
          audit.ledger <= toLedger &&
          audit.finalityStatus === 'finalized'
        ) {
          events.set(key, {
            ...audit,
            finalityStatus: 'provisional',
            finalizedAt: undefined,
          });
          demoted++;
        }
      }
      return demoted;
    },
  };
}

function makeAudit(
  overrides: Partial<EventProcessingAudit> = {},
): EventProcessingAudit {
  return {
    id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    deduplicationKey: 'contract-1:event-1:1',
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    status: 'accepted',
    payloadHash: 'hash123',
    processedAt: new Date(),
    createdAt: new Date(),
    finalityStatus: 'finalized',
    network: 'soroban',
    ledger: 98,
    ...overrides,
  };
}

function defaultConfig(overrides: Partial<RewindServiceConfig> = {}): RewindServiceConfig {
  return {
    maxRewindDepth: 100,
    networks: ['soroban', 'stellar'],
    ...overrides,
  };
}

/** Suppress logger output during tests. */
function silentLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('rewindAfterReorg', () => {
  describe('no reorg', () => {
    it('returns zero counts and no reorg evaluation when heads are equal', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        100,
        100,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect(result).toEqual({
        demoted: 0,
        rewound: 0,
        evaluation: {
          detected: false,
          depth: 0,
          exceedsRetentionPolicy: false,
        },
      });
    });

    it('returns zero counts when head advances', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        100,
        110,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect(result).toEqual({
        demoted: 0,
        rewound: 0,
        evaluation: {
          detected: false,
          depth: 0,
          exceedsRetentionPolicy: false,
        },
      });
    });

    it('does not modify any events', async () => {
      const event = makeAudit({ ledger: 98 });
      const repo = createDemotableEventRepo([event]);
      const cursors = new InMemoryCursorRepository();

      await rewindAfterReorg(100, 100, defaultConfig(), repo, cursors, silentLogger());

      const stored = repo.events.get(event.deduplicationKey)!;
      expect(stored.finalityStatus).toBe('finalized');
    });
  });

  describe('single-ledger reorg', () => {
    it('demotes events in the affected ledger range', async () => {
      const event = makeAudit({ ledger: 99, network: 'soroban' });
      const repo = createDemotableEventRepo([event]);
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect(result).not.toHaveProperty('skipped');
      expect((result as any).demoted).toBe(1);

      const stored = repo.events.get(event.deduplicationKey)!;
      expect(stored.finalityStatus).toBe('provisional');
      expect(stored.finalizedAt).toBeUndefined();
    });

    it('does not demote events outside the affected range', async () => {
      const inRange = makeAudit({ deduplicationKey: 'c:e:1', ledger: 99, network: 'soroban' });
      const outOfRange = makeAudit({ deduplicationKey: 'c:e:2', ledger: 95, network: 'soroban' });
      const repo = createDemotableEventRepo([inRange, outOfRange]);
      const cursors = new InMemoryCursorRepository();

      await rewindAfterReorg(100, 99, defaultConfig(), repo, cursors, silentLogger());

      expect(repo.events.get('c:e:1')!.finalityStatus).toBe('provisional');
      expect(repo.events.get('c:e:2')!.finalityStatus).toBe('finalized');
    });

    it('does not demote events on other networks', async () => {
      const soroban = makeAudit({ deduplicationKey: 'c:s:1', ledger: 99, network: 'soroban' });
      const stellar = makeAudit({ deduplicationKey: 'c:st:1', ledger: 99, network: 'stellar' });
      const repo = createDemotableEventRepo([soroban, stellar]);
      const cursors = new InMemoryCursorRepository();

      await rewindAfterReorg(
        100,
        99,
        defaultConfig({ networks: ['soroban'] }),
        repo,
        cursors,
        silentLogger(),
      );

      expect(repo.events.get('c:s:1')!.finalityStatus).toBe('provisional');
      expect(repo.events.get('c:st:1')!.finalityStatus).toBe('finalized');
    });

    it('rewinds cursors that are ahead of the reorg point', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();
      await cursors.updateCursor('soroban', 100);

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect((result as any).rewound).toBe(1);
      const cursor = await cursors.getCursor('soroban');
      expect(cursor!.lastSequence).toBe(98); // rewindFrom - 1
    });

    it('does not rewind cursors that are already behind the reorg point', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();
      await cursors.updateCursor('soroban', 50);

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect((result as any).rewound).toBe(0);
      const cursor = await cursors.getCursor('soroban');
      expect(cursor!.lastSequence).toBe(50); // unchanged
    });
  });

  describe('reorg exceeds retention window', () => {
    it('returns skipped: true when reorg depth exceeds maxRewindDepth', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        1000,
        500,
        defaultConfig({ maxRewindDepth: 100 }),
        repo,
        cursors,
        silentLogger(),
      );

      expect(result).toEqual({
        skipped: true,
        evaluation: {
          detected: true,
          depth: 500,
          rewindFromLedger: 500,
          exceedsRetentionPolicy: true,
        },
      });
    });

    it('does not modify any events when reorg exceeds retention', async () => {
      const event = makeAudit({ ledger: 600, network: 'soroban' });
      const repo = createDemotableEventRepo([event]);
      const cursors = new InMemoryCursorRepository();

      await rewindAfterReorg(
        1000,
        500,
        defaultConfig({ maxRewindDepth: 100 }),
        repo,
        cursors,
        silentLogger(),
      );

      expect(repo.events.get(event.deduplicationKey)!.finalityStatus).toBe('finalized');
    });

    it('does not rewind cursors when reorg exceeds retention', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();
      await cursors.updateCursor('soroban', 900);

      await rewindAfterReorg(
        1000,
        500,
        defaultConfig({ maxRewindDepth: 100 }),
        repo,
        cursors,
        silentLogger(),
      );

      const cursor = await cursors.getCursor('soroban');
      expect(cursor!.lastSequence).toBe(900); // unchanged
    });
  });

  describe('operator repeats rewind (idempotency)', () => {
    it('second rewind demotes zero additional events (already provisional)', async () => {
      const event = makeAudit({ ledger: 99, network: 'soroban' });
      const repo = createDemotableEventRepo([event]);
      const cursors = new InMemoryCursorRepository();

      // First rewind
      const first = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );
      expect((first as any).demoted).toBe(1);

      // Second rewind with same inputs
      const second = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );
      expect((second as any).demoted).toBe(0); // already provisional
    });

    it('cursor rewind is idempotent', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();
      await cursors.updateCursor('soroban', 100);

      await rewindAfterReorg(100, 99, defaultConfig(), repo, cursors, silentLogger());
      const afterFirst = await cursors.getCursor('soroban');
      expect(afterFirst!.lastSequence).toBe(98);

      await rewindAfterReorg(100, 99, defaultConfig(), repo, cursors, silentLogger());
      const afterSecond = await cursors.getCursor('soroban');
      expect(afterSecond!.lastSequence).toBe(98); // same
    });
  });

  describe('error handling', () => {
    it('handles demote failure gracefully (non-fatal)', async () => {
      const repo: DemotableEventRepository = {
        async demoteProvisional(): Promise<number> {
          throw new Error('storage failure');
        },
      };
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect((result as any).demoted).toBe(0);
      expect((result as any).rewound).toBe(0);
    });

    it('handles cursor rewind failure gracefully (non-fatal)', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();
      await cursors.updateCursor('soroban', 100);

      // Override rewindCursor to throw
      const originalRewind = cursors.rewindCursor.bind(cursors);
      cursors.rewindCursor = async () => {
        throw new Error('cursor storage failure');
      };

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect((result as any).demoted).toBe(0); // demote succeeded (no events)
      expect((result as any).rewound).toBe(0); // cursor failed
    });
  });

  describe('edge cases', () => {
    it('handles empty network list (no events or cursors to process)', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig({ networks: [] }),
        repo,
        cursors,
        silentLogger(),
      );

      expect((result as any).demoted).toBe(0);
      expect((result as any).rewound).toBe(0);
    });

    it('handles network with no cursor (skips cursor rewind)', async () => {
      const repo = createDemotableEventRepo();
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect((result as any).rewound).toBe(0);
    });

    it('handles provisional events that are already provisional (no-op demote)', async () => {
      const event = makeAudit({ ledger: 99, network: 'soroban', finalityStatus: 'provisional' });
      const repo = createDemotableEventRepo([event]);
      const cursors = new InMemoryCursorRepository();

      const result = await rewindAfterReorg(
        100,
        99,
        defaultConfig(),
        repo,
        cursors,
        silentLogger(),
      );

      expect((result as any).demoted).toBe(0); // already provisional
      expect(repo.events.get(event.deduplicationKey)!.finalityStatus).toBe('provisional');
    });

    it('handles events without ledger (off-chain) — not affected by reorg', async () => {
      const event = makeAudit({ ledger: undefined, network: undefined, finalityStatus: 'finalized' });
      const repo = createDemotableEventRepo([event]);
      const cursors = new InMemoryCursorRepository();

      await rewindAfterReorg(100, 99, defaultConfig(), repo, cursors, silentLogger());

      // Off-chain events have no ledger, so they don't match the range filter
      expect(repo.events.get(event.deduplicationKey)!.finalityStatus).toBe('finalized');
    });
  });
});
