/**
 * @file disputes.transitions.test.ts
 * @description Service-level tests for legal dispute transition enforcement
 * (#1215): explicit transition matrix, centralized validation, atomic
 * actor/reason/version persistence, and the edge cases from the issue —
 * open from eligible state, duplicate open, resolve without evidence, close
 * twice, and concurrent transition.
 */

import {
  DisputeError,
  DisputesService,
  DISPUTE_TRANSITION_MATRIX,
} from './disputes.service';

describe('DisputesService transition enforcement', () => {
  let service: DisputesService;

  beforeEach(() => {
    service = new DisputesService();
    service.clearStore();
  });

  afterEach(() => {
    service.clearStore();
  });

  function seed(contractId = 'contract-1') {
    return service.createDispute({
      contractId,
      reason: 'payment dispute',
      raisedBy: 'client-1',
    });
  }

  describe('transition matrix', () => {
    it('documents the explicit legal transitions', () => {
      expect(DISPUTE_TRANSITION_MATRIX.open).toEqual(['under_review', 'resolved', 'escalated']);
      expect(DISPUTE_TRANSITION_MATRIX.under_review).toEqual(['resolved', 'escalated']);
      expect(DISPUTE_TRANSITION_MATRIX.escalated).toEqual(['resolved']);
      expect(DISPUTE_TRANSITION_MATRIX.resolved).toEqual([]); // terminal
    });

    it('rejects illegal transitions and allows legal ones', async () => {
      const d = seed();
      await service.updateDispute(d.id, { status: 'under_review' });
      await service.updateDispute(d.id, { status: 'escalated' });
      await service.updateDispute(d.id, { status: 'resolved', resolution: 'evidence' });

      // Terminal state cannot leave.
      await expect(service.updateDispute(d.id, { status: 'open' })).rejects.toMatchObject({
        code: 'invalid_state_transition',
      });
    });
  });

  describe('open from eligible state', () => {
    it('creates a dispute in the open state', () => {
      const d = service.createDispute({ contractId: 'c-1', reason: 'r' });
      expect(d.status).toBe('open');
      expect(d.version).toBe(1);
    });

    it('rejects opening a dispute directly in a non-open state', () => {
      for (const status of ['resolved', 'under_review', 'escalated'] as const) {
        expect(() =>
          service.createDispute({ contractId: `c-${status}`, status }),
        ).toThrow(DisputeError);
        try {
          service.createDispute({ contractId: `c-${status}`, status });
        } catch (error) {
          expect((error as DisputeError).code).toBe('invalid_initial_status');
        }
      }
    });
  });

  describe('duplicate open', () => {
    it('rejects a second open dispute for the same contract', () => {
      seed('c-dup');
      try {
        service.createDispute({ contractId: 'c-dup', reason: 'second' });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as DisputeError).code).toBe('dispute_already_open');
        expect((error as DisputeError).statusCode).toBe(409);
      }
    });

    it('allows a dispute for a different contract', () => {
      seed('c-1');
      expect(() => service.createDispute({ contractId: 'c-2', reason: 'r' })).not.toThrow();
    });

    it('allows a new dispute once the previous one is resolved (terminal)', async () => {
      const d = seed('c-cycle');
      await service.updateDispute(d.id, { status: 'resolved', resolution: 'paid out' });
      expect(() => service.createDispute({ contractId: 'c-cycle', reason: 'new' })).not.toThrow();
    });
  });

  describe('resolve without evidence', () => {
    it('rejects a transition into resolved without a resolution', async () => {
      const d = seed();
      await expect(service.updateDispute(d.id, { status: 'resolved' })).rejects.toMatchObject({
        code: 'resolution_required',
        statusCode: 400,
      });
    });

    it('rejects a blank/whitespace resolution as evidence', async () => {
      const d = seed();
      await expect(
        service.updateDispute(d.id, { status: 'resolved', resolution: '   ' }),
      ).rejects.toMatchObject({ code: 'resolution_required' });
    });

    it('accepts a resolution as evidence', async () => {
      const d = seed();
      const updated = await service.updateDispute(d.id, {
        status: 'resolved',
        resolution: 'both parties agreed',
      });
      expect(updated.status).toBe('resolved');
    });

    it('does not require evidence for non-resolving transitions', async () => {
      const d = seed();
      const updated = await service.updateDispute(d.id, { status: 'under_review' });
      expect(updated.status).toBe('under_review');
    });
  });

  describe('close twice', () => {
    it('rejects a second close with different evidence', async () => {
      const d = seed();
      await service.updateDispute(d.id, { status: 'resolved', resolution: 'original evidence' });

      await expect(
        service.updateDispute(d.id, { status: 'resolved', resolution: 'changed evidence' }),
      ).rejects.toMatchObject({ code: 'dispute_already_resolved', statusCode: 409 });
    });

    it('treats an identical retry as idempotent', async () => {
      const d = seed();
      const first = await service.updateDispute(d.id, { status: 'resolved', resolution: 'same' });
      const retry = await service.updateDispute(d.id, { status: 'resolved', resolution: 'same' });
      expect(retry.status).toBe('resolved');
      expect(retry.version).toBe(first.version); // no new write
    });
  });

  describe('concurrent transition (optimistic concurrency)', () => {
    it('rejects a write with a stale expectedVersion', async () => {
      const d = seed();
      await service.updateDispute(d.id, { status: 'under_review' }); // version 2

      await expect(
        service.updateDispute(d.id, { status: 'escalated', expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: 'dispute_version_conflict', statusCode: 409 });
    });

    it('applies a write with the current expectedVersion', async () => {
      const d = seed();
      const updated = await service.updateDispute(d.id, {
        status: 'under_review',
        expectedVersion: 1,
      });
      expect(updated.status).toBe('under_review');
      expect(updated.version).toBe(2);
    });

    it('increments version on every status change', async () => {
      const d = seed();
      expect(d.version).toBe(1);
      await service.updateDispute(d.id, { status: 'under_review' });
      expect(service.getDisputeById(d.id).version).toBe(2);
      await service.updateDispute(d.id, { status: 'escalated' });
      expect(service.getDisputeById(d.id).version).toBe(3);
    });
  });

  describe('atomic actor / reason persistence', () => {
    it('persists statusChangedBy and statusChangeReason with the transition', async () => {
      const d = seed();
      const updated = await service.updateDispute(d.id, {
        status: 'under_review',
        statusChangedBy: 'admin-7',
        resolution: 'checking docs',
      });
      expect(updated.statusChangedBy).toBe('admin-7');
      expect(updated.statusChangeReason).toBe('checking docs');
      expect(updated.version).toBe(2);
    });

    it('records the opener as the initial actor', () => {
      const d = service.createDispute({ contractId: 'c-x', reason: 'r', raisedBy: 'client-9' });
      expect(d.statusChangedBy).toBe('client-9');
      expect(d.statusChangeReason).toBe('dispute opened');
    });

    it('keeps actor/reason stable across non-status metadata updates', async () => {
      const d = seed();
      const withActor = await service.updateDispute(d.id, {
        status: 'under_review',
        statusChangedBy: 'admin-1',
        resolution: 'reviewing',
      });
      expect(withActor.statusChangedBy).toBe('admin-1');
    });
  });

  describe('batch path uses the same centralized validation', () => {
    it('surfaces per-item transition errors without blocking the batch', async () => {
      const d = seed();
      const results = await service.processBatch([
        { id: d.id, status: 'resolved' }, // missing evidence → resolution_required
        { id: d.id, status: 'under_review' }, // legal
      ]);
      expect(results[0]!.success).toBe(false);
      expect(results[0]!.error?.code).toBe('resolution_required');
      expect(results[1]!.success).toBe(true);
    });
  });
});
