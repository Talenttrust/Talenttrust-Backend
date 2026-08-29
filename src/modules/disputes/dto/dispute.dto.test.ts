import {
  mapToCreateDisputeDto,
  mapToUpdateDisputeDto,
  mapToDisputeResponse
} from './dispute.dto';

describe('Dispute DTO mapping', () => {
  describe('mapToCreateDisputeDto', () => {
    it('should map valid fields and ignore undefined/extras', () => {
      const input = {
        contractId: 'contract-123',
        reason: 'Late delivery',
        raisedBy: 'user-456',
        extraField: 'should be ignored'
      };
      const result = mapToCreateDisputeDto(input);
      expect(result).toEqual({
        contractId: 'contract-123',
        reason: 'Late delivery',
        raisedBy: 'user-456'
      });
      // @ts-ignore
      expect(result.extraField).toBeUndefined();
    });

    it('should handle missing optional fields', () => {
      const input = {
        reason: 'Late delivery'
      };
      const result = mapToCreateDisputeDto(input);
      expect(result).toEqual({
        reason: 'Late delivery'
      });
    });

    it('should handle null or undefined input safely', () => {
      expect(mapToCreateDisputeDto(null)).toEqual({});
      expect(mapToCreateDisputeDto(undefined)).toEqual({});
    });
  });

  describe('mapToUpdateDisputeDto', () => {
    it('should map valid fields and ignore extras', () => {
      const input = {
        status: 'resolved',
        resolution: 'refund',
        clientRefundAmount: 100,
        extra: 'ignore me'
      };
      const result = mapToUpdateDisputeDto(input);
      expect(result).toEqual({
        status: 'resolved',
        resolution: 'refund',
        clientRefundAmount: 100
      });
    });

    it('should handle missing optional fields', () => {
      expect(mapToUpdateDisputeDto({})).toEqual({});
      expect(mapToUpdateDisputeDto(null)).toEqual({});
    });
  });

  describe('mapToDisputeResponse', () => {
    it('should perform round-trip mapping for full dispute', () => {
      const input = {
        id: 'dispute-1',
        status: 'in_progress',
        contractId: 'contract-1',
        reason: 'Quality issue',
        raisedBy: 'client-1',
        resolution: 'pending',
        resolvedBy: 'admin-1',
        clientRefundAmount: 50,
        freelancerReleaseAmount: 50,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
        internalSecret: 'hide me'
      };
      const result = mapToDisputeResponse(input);
      expect(result).toEqual({
        id: 'dispute-1',
        status: 'in_progress',
        contractId: 'contract-1',
        reason: 'Quality issue',
        raisedBy: 'client-1',
        resolution: 'pending',
        resolvedBy: 'admin-1',
        clientRefundAmount: 50,
        freelancerReleaseAmount: 50,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z'
      });
      // @ts-ignore
      expect(result.internalSecret).toBeUndefined();
    });

    it('should default status to open if missing', () => {
      const input = { id: 'dispute-2' };
      const result = mapToDisputeResponse(input);
      expect(result).toEqual({
        id: 'dispute-2',
        status: 'open'
      });
    });

    it('should map minimal response safely', () => {
      const result = mapToDisputeResponse(null);
      expect(result).toEqual({
        id: undefined,
        status: 'open'
      });
    });
  });
});
