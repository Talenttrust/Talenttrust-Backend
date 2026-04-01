/**
 * Blockchain Processor Tests
 * 
 * Unit tests for blockchain synchronization processing.
 */

import { processBlockchainSync } from './blockchain-processor';
import { BlockchainSyncPayload } from '../types';

describe('Blockchain Processor', () => {
  describe('processBlockchainSync', () => {
    it('should sync stellar blockchain', async () => {
      const payload: BlockchainSyncPayload = {
        network: 'stellar',
        startBlock: 0,
        endBlock: 50,
      };

      const result = await processBlockchainSync(payload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Blockchain sync completed');
      expect(result.data).toHaveProperty('network', 'stellar');
      expect(result.data).toHaveProperty('blocksProcessed');
    });

    it('should sync soroban blockchain', async () => {
      const payload: BlockchainSyncPayload = {
        network: 'soroban',
        startBlock: 100,
        endBlock: 200,
      };

      const result = await processBlockchainSync(payload);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('network', 'soroban');
    });

    it('should sync without explicit block range', async () => {
      const payload: BlockchainSyncPayload = {
        network: 'stellar',
      };

      const result = await processBlockchainSync(payload);
      expect(result.success).toBe(true);
    });

    it('should reject invalid network', async () => {
      const payload = {
        network: 'ethereum',
      } as BlockchainSyncPayload;

      await expect(processBlockchainSync(payload)).rejects.toThrow(
        'Invalid network'
      );
    });

    it('should reject invalid block range', async () => {
      const payload: BlockchainSyncPayload = {
        network: 'stellar',
        startBlock: 100,
        endBlock: 50,
      };

      await expect(processBlockchainSync(payload)).rejects.toThrow(
        'Start block must be less than or equal to end block'
      );
    });

    it('should process large block ranges', async () => {
      const payload: BlockchainSyncPayload = {
        network: 'stellar',
        startBlock: 0,
        endBlock: 1000,
      };

      const result = await processBlockchainSync(payload);

      expect(result.success).toBe(true);
      expect((result.data as any).blocksProcessed).toBeGreaterThan(0);
    });
  });
});
