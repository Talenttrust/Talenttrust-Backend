import { DisputesService, DisputeError } from './disputes.service';

jest.mock('../hooks/escrow.hooks', () => ({
  EscrowHooks: {
    onStateTransition: jest.fn().mockResolvedValue(null),
  },
}));

describe('DisputesService', () => {
  let service: DisputesService;

  beforeEach(() => {
    service = new DisputesService();
    service.seedDemoDisputes();
  });

  describe('getDisputeById', () => {
    it('returns a dispute when it exists', () => {
      const dispute = service.getDisputeById('dispute-001');
      expect(dispute).toBeDefined();
      expect(dispute.id).toBe('dispute-001');
      expect(dispute.status).toBe('open');
    });

    it('throws 404 when dispute does not exist', () => {
      expect(() => service.getDisputeById('nonexistent')).toThrow(DisputeError);
      try {
        service.getDisputeById('nonexistent');
      } catch (err) {
        expect((err as DisputeError).statusCode).toBe(404);
        expect((err as DisputeError).code).toBe('dispute_not_found');
      }
    });
  });

  describe('validateTransition', () => {
    it('accepts valid transition from open to under_review', () => {
      expect(() => service.validateTransition('open', 'under_review')).not.toThrow();
    });

    it('accepts valid transition from open to resolved', () => {
      expect(() => service.validateTransition('open', 'resolved')).not.toThrow();
    });

    it('accepts valid transition from under_review to resolved', () => {
      expect(() => service.validateTransition('under_review', 'resolved')).not.toThrow();
    });

    it('accepts same-status transition (idempotent retry)', () => {
      expect(() => service.validateTransition('open', 'open')).not.toThrow();
    });

    it('rejects invalid transition from resolved to open', () => {
      expect(() => service.validateTransition('resolved', 'open')).toThrow(DisputeError);
    });

    it('rejects invalid transition from resolved to under_review', () => {
      expect(() => service.validateTransition('resolved', 'under_review')).toThrow(DisputeError);
    });

    it('rejects invalid transition from open to escalated via under_review only', () => {
      expect(() => service.validateTransition('under_review', 'open')).toThrow(DisputeError);
    });

    it('includes error details for invalid transitions', () => {
      try {
        service.validateTransition('resolved', 'open');
      } catch (err) {
        expect((err as DisputeError).code).toBe('invalid_state_transition');
        expect((err as DisputeError).statusCode).toBe(400);
      }
    });
  });

  describe('updateDispute', () => {
    it('updates dispute status when transition is valid', async () => {
      const updated = await service.updateDispute('dispute-001', { status: 'under_review' });
      expect(updated.status).toBe('under_review');
      expect(updated.id).toBe('dispute-001');
    });

    it('throws when dispute does not exist', async () => {
      await expect(
        service.updateDispute('nonexistent', { status: 'resolved' }),
      ).rejects.toThrow(DisputeError);
    });

    it('throws on invalid state transition', async () => {
      await expect(
        service.updateDispute('dispute-001', { status: 'escalated' }),
      ).rejects.toThrow(DisputeError);
    });

    it('updates resolution text', async () => {
      const updated = await service.updateDispute('dispute-001', {
        status: 'resolved',
        resolution: 'Refunded in full',
      });
      expect(updated.resolution).toBe('Refunded in full');
      expect(updated.status).toBe('resolved');
    });

    it('calls EscrowHooks.onStateTransition on status change', async () => {
      const { EscrowHooks } = require('../hooks/escrow.hooks');
      await service.updateDispute('dispute-001', { status: 'under_review' });
      expect(EscrowHooks.onStateTransition).toHaveBeenCalledWith(
        'open',
        'under_review',
        expect.objectContaining({ contractId: 'contract-001' }),
      );
    });

    it('does not call EscrowHooks when status is unchanged', async () => {
      const { EscrowHooks } = require('../hooks/escrow.hooks');
      EscrowHooks.onStateTransition.mockClear();
      await service.updateDispute('dispute-001', { resolution: 'Note added' });
      expect(EscrowHooks.onStateTransition).not.toHaveBeenCalled();
    });

    it('updates updatedAt timestamp', async () => {
      const before = service.getDisputeById('dispute-001').updatedAt;
      const updated = await service.updateDispute('dispute-001', { status: 'under_review' });
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('processBatch', () => {
    it('processes multiple operations independently', async () => {
      const results = await service.processBatch([
        { id: 'dispute-001', status: 'under_review' },
        { id: 'dispute-002', status: 'resolved' },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.dispute!.status).toBe('under_review');
      expect(results[1]!.success).toBe(true);
      expect(results[1]!.dispute!.status).toBe('resolved');
    });

    it('handles partial failures without affecting other items', async () => {
      const results = await service.processBatch([
        { id: 'dispute-001', status: 'under_review' },
        { id: 'nonexistent', status: 'resolved' },
        { id: 'dispute-002', status: 'resolved' },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]!.success).toBe(true);
      expect(results[1]!.success).toBe(false);
      expect(results[1]!.error).toBeDefined();
      expect(results[1]!.error!.code).toBe('dispute_not_found');
      expect(results[2]!.success).toBe(true);
    });

    it('returns error for invalid state transitions', async () => {
      const results = await service.processBatch([
        { id: 'dispute-001', status: 'escalated' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);
      expect(results[0]!.error!.code).toBe('invalid_state_transition');
    });

    it('returns empty array for empty input', async () => {
      const results = await service.processBatch([]);
      expect(results).toEqual([]);
    });
  });

  describe('seedDemoDisputes', () => {
    it('seeds demo disputes that can be retrieved', () => {
      const dispute1 = service.getDisputeById('dispute-001');
      const dispute2 = service.getDisputeById('dispute-002');
      expect(dispute1.contractId).toBe('contract-001');
      expect(dispute2.contractId).toBe('contract-002');
      expect(dispute2.status).toBe('under_review');
    });
  });
});
