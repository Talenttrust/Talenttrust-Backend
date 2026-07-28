import { SoftDeleteRetentionError } from '../utils/softDelete';
import {
  DisputeError,
  DisputesService,
  DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV,
  runDisputesSoftDeletePurge,
} from './disputes.service';

describe('DisputesService soft-delete', () => {
  let service: DisputesService;

  beforeEach(() => {
    service = new DisputesService();
    service.clearStore();
    delete process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    service.clearStore();
    delete process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  function seed(contractId = 'contract-1') {
    return service.createDispute({
      contractId,
      reason: 'payment dispute',
      raisedBy: 'client-1',
    });
  }

  it('create + list returns active dispute; soft-delete hides it from default reads', () => {
    const created = seed();
    expect(service.listDisputes()).toHaveLength(1);
    expect(service.getDisputeById(created.id).id).toBe(created.id);

    const deleted = service.softDeleteDispute(created.id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);

    expect(service.listDisputes()).toHaveLength(0);
    expect(() => service.getDisputeById(created.id)).toThrow(DisputeError);

    const withDeleted = service.listDisputes({ includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it('restore within retention window makes the dispute visible again', () => {
    process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const created = seed();
    service.softDeleteDispute(created.id, new Date('2026-01-01T00:00:00.000Z'));

    const restored = service.restoreDispute(
      created.id,
      new Date('2026-01-10T00:00:00.000Z'),
    );
    expect(restored.deletedAt).toBeNull();
    expect(service.listDisputes()).toHaveLength(1);
  });

  it('restore past retention window throws SoftDeleteRetentionError', () => {
    process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const created = seed();
    service.softDeleteDispute(created.id, new Date('2026-01-01T00:00:00.000Z'));

    expect(() =>
      service.restoreDispute(created.id, new Date('2026-03-01T00:00:00.000Z')),
    ).toThrow(SoftDeleteRetentionError);
  });

  it('purgeExpiredDisputes hard-deletes only past-window soft-deleted records', () => {
    process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const keep = seed();
    const purgeTarget = seed('c-purge');
    const recentDeleted = seed('c-recent');

    service.softDeleteDispute(purgeTarget.id, new Date('2025-01-01T00:00:00.000Z'));
    service.softDeleteDispute(recentDeleted.id, new Date('2026-07-01T00:00:00.000Z'));

    const purged = service.purgeExpiredDisputes(new Date('2026-07-20T00:00:00.000Z'));
    expect(purged).toBe(1);
    expect(service.storeSize()).toBe(2);
    expect(service.getDisputeById(keep.id).id).toBe(keep.id);
    expect(
      service.getDisputeById(recentDeleted.id, { includeDeleted: true }).id,
    ).toBe(recentDeleted.id);
    expect(() =>
      service.getDisputeById(purgeTarget.id, { includeDeleted: true }),
    ).toThrow(DisputeError);
  });

  it('runDisputesSoftDeletePurge delegates to purgeExpiredDisputes', () => {
    process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    // Use the singleton that the maintenance helper calls.
    const { disputesService } = require('./disputes.service') as typeof import('./disputes.service');
    disputesService.clearStore();
    const m = disputesService.createDispute({ contractId: 'c' });
    disputesService.softDeleteDispute(m.id, new Date('2020-01-01T00:00:00.000Z'));
    expect(runDisputesSoftDeletePurge(new Date('2026-07-01T00:00:00.000Z'))).toBe(1);
    disputesService.clearStore();
  });

  it('soft-deleting twice yields conflict; restoring active yields conflict', () => {
    const created = seed();
    service.softDeleteDispute(created.id);
    expect(() => service.softDeleteDispute(created.id)).toThrow(/already soft-deleted/);

    const active = seed();
    expect(() => service.restoreDispute(active.id)).toThrow(/not soft-deleted/);
  });

  it('rejects unknown dispute ids', () => {
    expect(() => service.softDeleteDispute('missing')).toThrow(DisputeError);
    expect(() => service.restoreDispute('missing')).toThrow(DisputeError);
    expect(() => service.getDisputeById('missing')).toThrow(DisputeError);
  });

  it('reads retention days from env', () => {
    expect(service.getRetentionDays()).toBe(30);
    process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV] = '14';
    expect(service.getRetentionDays()).toBe(14);
  });

  it('seedDemoDisputes populates active records', () => {
    service.seedDemoDisputes();
    expect(service.listDisputes()).toHaveLength(2);
  });

  it('validateTransition allows no-op and rejects invalid transitions', () => {
    expect(() => service.validateTransition('open', 'open')).not.toThrow();
    expect(() => service.validateTransition('resolved', 'open')).toThrow(
      /invalid_state_transition|Invalid state transition/,
    );
  });

  it('updateDispute applies status change on active disputes', async () => {
    const created = seed();
    const updated = await service.updateDispute(created.id, {
      status: 'under_review',
      resolution: 'looking into it',
    });
    expect(updated.status).toBe('under_review');
    expect(updated.resolution).toBe('looking into it');
  });

  it('updateDispute fails for soft-deleted disputes', async () => {
    const created = seed();
    service.softDeleteDispute(created.id);
    await expect(
      service.updateDispute(created.id, { status: 'resolved' }),
    ).rejects.toThrow(DisputeError);
  });

  it('processBatch isolates per-item failures', async () => {
    const a = seed();
    const results = await service.processBatch([
      { id: a.id, status: 'under_review' },
      { id: 'missing', status: 'resolved' },
    ]);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error?.code).toBe('dispute_not_found');
  });
});
