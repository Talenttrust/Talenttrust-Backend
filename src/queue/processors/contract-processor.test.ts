/**
 * Contract Processor Tests
 * 
 * Unit tests for contract processing operations.
 */

import { processContractProcessing } from './contract-processor';
import { ContractProcessingPayload } from '../types';

describe('Contract Processor', () => {
  describe('processContractProcessing', () => {
    it('should create a new contract', async () => {
      const payload: ContractProcessingPayload = {
        contractId: 'contract_12345',
        action: 'create',
        metadata: { amount: 1000, currency: 'USD' },
      };

      const result = await processContractProcessing(payload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('created');
      expect(result.data).toHaveProperty('contractId', payload.contractId);
      expect(result.data).toHaveProperty('status', 'active');
    });

    it('should update an existing contract', async () => {
      const payload: ContractProcessingPayload = {
        contractId: 'contract_12345',
        action: 'update',
        metadata: { status: 'in-progress' },
      };

      const result = await processContractProcessing(payload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('updated');
      expect(result.data).toHaveProperty('metadata');
    });

    it('should finalize a contract', async () => {
      const payload: ContractProcessingPayload = {
        contractId: 'contract_12345',
        action: 'finalize',
      };

      const result = await processContractProcessing(payload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('finalized');
      expect(result.data).toHaveProperty('status', 'completed');
    });

    it('should reject invalid contract ID', async () => {
      const payload: ContractProcessingPayload = {
        contractId: 'short',
        action: 'create',
      };

      await expect(processContractProcessing(payload)).rejects.toThrow(
        'Invalid contract ID'
      );
    });

    it('should reject empty contract ID', async () => {
      const payload: ContractProcessingPayload = {
        contractId: '',
        action: 'create',
      };

      await expect(processContractProcessing(payload)).rejects.toThrow(
        'Invalid contract ID'
      );
    });

    it('should reject invalid action', async () => {
      const payload = {
        contractId: 'contract_12345',
        action: 'invalid-action',
      } as ContractProcessingPayload;

      await expect(processContractProcessing(payload)).rejects.toThrow(
        'Invalid action'
      );
    });

    it('should handle contract with complex metadata', async () => {
      const payload: ContractProcessingPayload = {
        contractId: 'contract_complex',
        action: 'create',
        metadata: {
          freelancer: 'user_123',
          client: 'user_456',
          milestones: [
            { id: 1, amount: 500, description: 'Phase 1' },
            { id: 2, amount: 500, description: 'Phase 2' },
          ],
        },
      };

      const result = await processContractProcessing(payload);
      expect(result.success).toBe(true);
    });
  });
});
