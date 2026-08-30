/**
 * Raw event retention service tests.
 *
 * Covers every edge case from issue #1232:
 *  - retention disabled        → no-op, summary reports enabled: false
 *  - active hold               → held events are never archived/purged
 *  - already archived          → idempotent re-archive (no duplicate rows)
 *  - purge boundary            → exactly-at-boundary eligible, just-before not
 *  - mixed networks            → per-network retention classes respected
 * Plus: projection verification (fail-closed deferral), dry-run counting,
 * bounded runs, per-event failure isolation, and no payload leakage in logs.
 */

import {
  RawEventRetentionService,
  DEFAULT_RAW_EVENT_RETENTION_CONFIG,
  loadRawEventRetentionConfig,
  type RawEventProjectionVerifier,
  type RawEventRetentionAuditEntry,
  type RunRawEventRetentionInput,
} from './rawEventRetention';
import {
  InMemoryRawEventRetentionRepository,
  type RawEventRecord,
} from './rawEventRetention.repository';
import { setWriteRecordImpl, type LogRecord } from '../logger';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function makeEvent(overrides: Partial<RawEventRecord> = {}): RawEventRecord {
  return {
    eventId: 'evt-1',
    contractId: 'contract-1',
    eventType: 'escrow:created',
    payload: '{"secret":"sensitive","amount":500}',
    timestamp: '2026-05-01T00:00:00.000Z',
    network: 'soroban',
    ingestedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeService(overrides: {
  verifier?: RawEventProjectionVerifier;
  config?: typeof DEFAULT_RAW_EVENT_RETENTION_CONFIG;
  auditEntries?: RawEventRetentionAuditEntry[];
} = {}) {
  const repository = new InMemoryRawEventRetentionRepository();
  const auditEntries = overrides.auditEntries ?? [];
  const verifier =
    overrides.verifier ?? ({ verify: async () => ({ verified: true }) } as RawEventProjectionVerifier);
  const service = new RawEventRetentionService({
    repository,
    verifier,
    config: overrides.config ?? { ...DEFAULT_RAW_EVENT_RETENTION_CONFIG, enabled: true },
    auditSink: (entry) => auditEntries.push(entry),
  });
  return { service, repository, auditEntries };
}

function captureLogs(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  setWriteRecordImpl((r) => records.push(r));
  return {
    records,
    restore: () =>
      setWriteRecordImpl((r: LogRecord) => {
        const line = JSON.stringify(r);
        (r.level === 'error' ? process.stderr : process.stdout).write(line + '\n');
      }),
  };
}

describe('RawEventRetentionService', () => {
  describe('retention disabled', () => {
    it('is a no-op and reports enabled: false', async () => {
      const { service, repository } = makeService({
        config: { ...DEFAULT_RAW_EVENT_RETENTION_CONFIG, enabled: false },
      });
      repository.seed(makeEvent({ ingestedAt: '2020-01-01T00:00:00.000Z' }));

      const summary = await service.run({ now: NOW });

      expect(summary.enabled).toBe(false);
      expect(summary.scanned).toBe(0);
      expect(repository.findRawEvent('evt-1')).toBeDefined();
      expect(repository.isArchived('evt-1')).toBe(false);
    });
  });

  describe('active hold', () => {
    it('keeps held events untouched (contract scope)', async () => {
      const { service, repository } = makeService();
      repository.seed(makeEvent({ eventId: 'held', contractId: 'contract-held' }));
      repository.addHold({
        scopeType: 'contract',
        scopeValue: 'contract-held',
        reason: 'legal dispute',
        actor: 'compliance',
        createdAt: NOW.toISOString(),
      });

      const summary = await service.run({ now: NOW });

      expect(summary.held).toBe(1);
      expect(summary.archived).toBe(0);
      expect(repository.findRawEvent('held')).toBeDefined();
      expect(repository.isArchived('held')).toBe(false);
    });

    it('keeps held events untouched (network scope)', async () => {
      const { service, repository } = makeService();
      // Old enough to be a candidate under the stellar class (90d).
      repository.seed(
        makeEvent({ eventId: 'held-net', network: 'stellar', ingestedAt: '2020-01-01T00:00:00.000Z' }),
      );
      repository.addHold({
        scopeType: 'network',
        scopeValue: 'stellar',
        reason: 'audit hold',
        actor: 'compliance',
      });

      const summary = await service.run({ now: NOW });

      expect(summary.held).toBe(1);
      expect(summary.archived).toBe(0);
      expect(repository.findRawEvent('held-net')).toBeDefined();
    });

    it('ignores expired holds', async () => {
      const { service, repository } = makeService();
      repository.seed(makeEvent({ eventId: 'free' }));
      repository.addHold({
        scopeType: 'all',
        reason: 'expired hold',
        actor: 'compliance',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      });

      const summary = await service.run({ now: NOW });

      expect(summary.held).toBe(0);
      expect(summary.archived).toBe(1);
    });
  });

  describe('already archived', () => {
    it('re-archiving is idempotent and counts as alreadyArchived', async () => {
      const { service, repository } = makeService();
      repository.seed(makeEvent({ eventId: 'evt-1' }));

      const first = await service.run({ now: NOW });
      expect(first.archived).toBe(1);
      expect(repository.findRawEvent('evt-1')).toBeUndefined(); // purged after archive

      // A second run with postArchiveDays > 0 keeps the raw row, so seed again
      // and confirm the archive row is not duplicated.
      const repo2 = new InMemoryRawEventRetentionRepository();
      repo2.seed(makeEvent({ eventId: 'evt-1' }));
      const service2 = new RawEventRetentionService({
        repository: repo2,
        verifier: { verify: async () => ({ verified: true }) },
        config: {
          ...DEFAULT_RAW_EVENT_RETENTION_CONFIG,
          enabled: true,
          postArchiveDays: 30,
        },
        auditSink: () => undefined,
      });

      const firstRun = await service2.run({ now: NOW });
      expect(firstRun.archived).toBe(1);
      // Raw row retained (postArchiveDays > 0); archive row exists.
      expect(repo2.findRawEvent('evt-1')).toBeDefined();
      expect(repo2.isArchived('evt-1')).toBe(true);

      const secondRun = await service2.run({ now: NOW });
      expect(secondRun.alreadyArchived).toBe(1);
      expect(secondRun.archived).toBe(0);
    });
  });

  describe('purge boundary', () => {
    it('archives/purges an event exactly at its retention boundary', async () => {
      const { service, repository } = makeService();
      // soroban period = 30 days; ingested exactly 30 days before NOW.
      const boundary = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      repository.seed(makeEvent({ eventId: 'boundary', ingestedAt: boundary }));

      const summary = await service.run({ now: NOW });

      expect(summary.archived).toBe(1);
      expect(summary.purged).toBe(1);
    });

    it('defers an event ingested just before its boundary', async () => {
      const { service, repository } = makeService();
      const justBefore = new Date(
        NOW.getTime() - (30 * 24 * 60 * 60 * 1000 - 1),
      ).toISOString();
      repository.seed(makeEvent({ eventId: 'not-yet', ingestedAt: justBefore }));

      const summary = await service.run({ now: NOW });

      expect(summary.scanned).toBe(0);
      expect(repository.findRawEvent('not-yet')).toBeDefined();
    });
  });

  describe('mixed networks', () => {
    it('applies per-network retention classes independently', async () => {
      const { service, repository } = makeService();
      // soroban: 30d; stellar: 90d (defaults). An event aged 60 days:
      //  - soroban → eligible
      //  - stellar → not yet eligible
      const sixtyDaysAgo = new Date(
        NOW.getTime() - 60 * 24 * 60 * 60 * 1000,
      ).toISOString();
      repository.seed(
        makeEvent({ eventId: 'soroban-old', network: 'soroban', ingestedAt: sixtyDaysAgo }),
      );
      repository.seed(
        makeEvent({ eventId: 'stellar-young', network: 'stellar', ingestedAt: sixtyDaysAgo }),
      );

      const summary = await service.run({ now: NOW });

      expect(summary.scanned).toBe(1);
      expect(repository.isArchived('soroban-old')).toBe(true);
      expect(repository.findRawEvent('stellar-young')).toBeDefined();
      expect(summary.byNetwork.soroban?.archived).toBe(1);
      expect(summary.byNetwork.stellar?.scanned ?? 0).toBe(0);
    });

    it('scopes a run to a single network', async () => {
      const { service, repository } = makeService();
      // 200 days old: past the stellar (90d) boundary, and past the soroban
      // (30d) boundary — but the scoped run must only touch stellar.
      const twoHundredDaysAgo = new Date(
        NOW.getTime() - 200 * 24 * 60 * 60 * 1000,
      ).toISOString();
      repository.seed(
        makeEvent({ eventId: 'soroban-old', network: 'soroban', ingestedAt: twoHundredDaysAgo }),
      );
      repository.seed(
        makeEvent({ eventId: 'stellar-old', network: 'stellar', ingestedAt: twoHundredDaysAgo }),
      );

      const summary = await service.run({
        now: NOW,
        network: 'stellar',
      } as RunRawEventRetentionInput);

      expect(repository.isArchived('stellar-old')).toBe(true);
      expect(repository.findRawEvent('soroban-old')).toBeDefined();
      expect(summary.byNetwork.soroban?.scanned ?? 0).toBe(0);
    });
  });

  describe('projection verification', () => {
    it('defers events whose projection is not verified (fail-closed)', async () => {
      const verifier: RawEventProjectionVerifier = {
        verify: async () => ({ verified: false, reason: 'no_accepted_projection' }),
      };
      const { service, repository } = makeService({ verifier });
      repository.seed(makeEvent({ eventId: 'unverified' }));

      const summary = await service.run({ now: NOW });

      expect(summary.deferred).toBe(1);
      expect(summary.archived).toBe(0);
      expect(repository.findRawEvent('unverified')).toBeDefined();
      expect(repository.isArchived('unverified')).toBe(false);
    });

    it('archives only after the projection verifies', async () => {
      const { service, repository } = makeService();
      repository.seed(makeEvent({ eventId: 'verified' }));
      const summary = await service.run({ now: NOW });
      expect(summary.archived).toBe(1);
      expect(repository.isArchived('verified')).toBe(true);
    });
  });

  describe('dry run', () => {
    it('counts candidates without archiving or purging anything', async () => {
      const { service, repository } = makeService();
      repository.seed(makeEvent({ eventId: 'dry' }));

      const summary = await service.run({ now: NOW, dryRun: true });

      expect(summary.scanned).toBe(1);
      expect(summary.archived).toBe(0);
      expect(summary.purged).toBe(0);
      expect(repository.findRawEvent('dry')).toBeDefined();
      expect(repository.isArchived('dry')).toBe(false);
    });
  });

  describe('bounded runs', () => {
    it('processes at most maxEvents per run', async () => {
      const { service, repository } = makeService();
      for (let i = 0; i < 50; i += 1) {
        repository.seed(
          makeEvent({ eventId: `evt-${i}`, contractId: `c-${i}`, ingestedAt: '2020-01-01T00:00:00.000Z' }),
        );
      }

      const summary = await service.run({ now: NOW, maxEvents: 10 });

      expect(summary.scanned).toBe(10);
      expect(summary.archived).toBe(10);
      expect(repository.countCandidates({
        cutoffByNetwork: {
          soroban: '2020-01-01T00:00:00.000Z',
          stellar: '2020-01-01T00:00:00.000Z',
          offchain: '2020-01-01T00:00:00.000Z',
        },
        limit: 1000,
      })).toBe(40); // remaining candidates
    });
  });

  describe('failure isolation', () => {
    it('records failures without aborting the run or leaking payloads', async () => {
      const { records, restore } = captureLogs();
      try {
        const verifier: RawEventProjectionVerifier = {
          verify: async (event) => {
            if (event.eventId === 'boom') throw new Error('verifier exploded');
            return { verified: true };
          },
        };
        const { service, repository } = makeService({ verifier });
        repository.seed(makeEvent({ eventId: 'boom' }));
        repository.seed(makeEvent({ eventId: 'ok' }));

        const summary = await service.run({ now: NOW });

        expect(summary.failed).toBe(1);
        expect(summary.archived).toBe(1);

        // No log record contains the sensitive payload content.
        for (const r of records) {
          expect(JSON.stringify(r)).not.toContain('sensitive');
          expect(JSON.stringify(r)).not.toContain('"secret"');
        }
      } finally {
        restore();
      }
    });
  });

  describe('audit sink', () => {
    it('records counts and hashes without raw payload content', async () => {
      const auditEntries: RawEventRetentionAuditEntry[] = [];
      const { service, repository } = makeService({ auditEntries });
      repository.seed(makeEvent({ eventId: 'audited' }));

      await service.run({ now: NOW });

      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0]!.resourceId).toBe('audited');
      expect(auditEntries[0]!.metadata.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(auditEntries)).not.toContain('sensitive');
    });
  });

  describe('config parsing', () => {
    it('loads env overrides and clamps to safe bounds', () => {
      const config = loadRawEventRetentionConfig({
        RAW_EVENT_RETENTION_ENABLED: 'true',
        RAW_EVENT_RETENTION_SOROBAN_DAYS: '45',
        RAW_EVENT_RETENTION_MAX_PER_RUN: '99999',
      } as NodeJS.ProcessEnv);

      expect(config.enabled).toBe(true);
      expect(config.classes.soroban.periodDays).toBe(45);
      // A value above the hard cap falls back to the default (500).
      expect(config.maxPerRun).toBe(500);
    });

    it('keeps other bounds when one env value is malformed', () => {
      const config = loadRawEventRetentionConfig({
        RAW_EVENT_RETENTION_ENABLED: 'true',
        RAW_EVENT_RETENTION_SOROBAN_DAYS: 'not-a-number',
        RAW_EVENT_RETENTION_STELLAR_DAYS: '120',
      } as NodeJS.ProcessEnv);

      expect(config.enabled).toBe(true);
      expect(config.classes.soroban.periodDays).toBe(30); // fell back
      expect(config.classes.stellar.periodDays).toBe(120); // still applied
    });

    it('falls back to defaults when disabled/missing', () => {
      const config = loadRawEventRetentionConfig({} as NodeJS.ProcessEnv);
      expect(config.enabled).toBe(false);
      expect(config.classes.stellar.periodDays).toBe(90);
    });
  });
});
