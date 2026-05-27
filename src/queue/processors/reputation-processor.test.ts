/**
 * Reputation Processor Tests
 * 
 * Unit tests for reputation update processing.
 */

import { processReputationUpdate } from './reputation-processor';
import { ReputationUpdatePayload } from '../types';

describe('Reputation Processor', () => {
  describe('processReputationUpdate', () => {
    it('should process valid reputation update', async () => {
      const payload: ReputationUpdatePayload = {
        userId: 'user_12345',
        contractId: 'contract_67890',
        rating: 5,
        feedback: 'Excellent work!',
      };

      const result = await processReputationUpdate(payload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Reputation updated');
      expect(result.data).toHaveProperty('userId', payload.userId);
      expect(result.data).toHaveProperty('newScore');
    });

    it('should process reputation without feedback', async () => {
      const payload: ReputationUpdatePayload = {
        userId: 'user_12345',
        contractId: 'contract_67890',
        rating: 4,
      };

      const result = await processReputationUpdate(payload);
      expect(result.success).toBe(true);
    });

    it('should reject invalid user ID', async () => {
      const payload: ReputationUpdatePayload = {
        userId: 'usr',
        contractId: 'contract_67890',
        rating: 5,
      };

      await expect(processReputationUpdate(payload)).rejects.toThrow(
        'Invalid user ID'
      );
    });

    it('should reject rating below minimum', async () => {
      const payload: ReputationUpdatePayload = {
        userId: 'user_12345',
        contractId: 'contract_67890',
        rating: 0,
      };

      await expect(processReputationUpdate(payload)).rejects.toThrow(
        'Rating must be between 1 and 5'
      );
    });

    it('should reject rating above maximum', async () => {
      const payload: ReputationUpdatePayload = {
        userId: 'user_12345',
        contractId: 'contract_67890',
        rating: 6,
      };

      await expect(processReputationUpdate(payload)).rejects.toThrow(
        'Rating must be between 1 and 5'
      );
    });

    it('should reject missing contract ID', async () => {
      const payload: ReputationUpdatePayload = {
        userId: 'user_12345',
        contractId: '',
        rating: 5,
      };

      await expect(processReputationUpdate(payload)).rejects.toThrow(
        'Contract ID is required'
      );
    });

    it('should calculate different scores for different ratings', async () => {
      const ratings = [1, 2, 3, 4, 5];
      const scores: number[] = [];

      for (const rating of ratings) {
        const payload: ReputationUpdatePayload = {
          userId: 'user_12345',
          contractId: 'contract_67890',
          rating,
        };

        const result = await processReputationUpdate(payload);
        scores.push((result.data as any).newScore);
      }

      // Scores should be monotonically increasing
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });
  });
});
