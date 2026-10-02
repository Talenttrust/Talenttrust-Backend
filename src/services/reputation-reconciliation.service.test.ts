import { ReputationReconciliationService } from './reputation-reconciliation.service';
import { ReputationRepository } from '../repositories/reputationRepository';
import { ReputationClient, ReputationError } from '../dependencies/reputationClient';
import { ReputationService } from './reputation.service';
import { randomUUID } from 'crypto';

jest.mock('./reputation.service');
jest.mock('../logger'); // Ensure logs don't pollute test output

describe('ReputationReconciliationService', () => {
  let repository: jest.Mocked<ReputationRepository>;
  let client: jest.Mocked<ReputationClient>;
  let service: ReputationReconciliationService;

  beforeEach(() => {
    repository = {
      getDistinctTargetIdPage: jest.fn(),
    } as unknown as jest.Mocked<ReputationRepository>;

    client = {
      getProfile: jest.fn(),
    } as unknown as jest.Mocked<ReputationClient>;

    service = new ReputationReconciliationService(repository, client);

    jest.resetAllMocks();
  });

  it('handles consistent data', async () => {
    const targetId = randomUUID();
    repository.getDistinctTargetIdPage.mockReturnValueOnce([targetId]).mockReturnValueOnce([]);
    
    (ReputationService.getProfile as jest.Mock).mockReturnValue({
      score: 4.5,
      weightedScore: 4.0
    });

    client.getProfile.mockResolvedValue({
      freelancerId: targetId,
      score: 4.5,
      weightedScore: 4.0,
      totalRatings: 1,
      reviews: []
    });

    const report = await service.reconcile(10);
    expect(report.processedCount).toBe(1);
    expect(report.consistentCount).toBe(1);
    expect(report.discrepancies.length).toBe(0);
  });

  it('handles missing record', async () => {
    const targetId = randomUUID();
    repository.getDistinctTargetIdPage.mockReturnValueOnce([targetId]).mockReturnValueOnce([]);
    
    (ReputationService.getProfile as jest.Mock).mockReturnValue({
      score: 4.5,
      weightedScore: 4.0
    });

    // Upstream client throws 404
    client.getProfile.mockRejectedValue(new ReputationError(404, {}, 'Not found'));

    const report = await service.reconcile(10);
    expect(report.processedCount).toBe(1);
    expect(report.consistentCount).toBe(0);
    expect(report.discrepancies.length).toBe(1);
    expect(report.discrepancies[0]).toEqual(expect.objectContaining({
      targetId,
      issue: 'missing_upstream'
    }));
  });

  it('handles score mismatch', async () => {
    const targetId = randomUUID();
    repository.getDistinctTargetIdPage.mockReturnValueOnce([targetId]).mockReturnValueOnce([]);
    
    (ReputationService.getProfile as jest.Mock).mockReturnValue({
      score: 4.5,
      weightedScore: 4.0
    });

    client.getProfile.mockResolvedValue({
      freelancerId: targetId,
      score: 4.0, // Mismatch
      weightedScore: 4.0,
      totalRatings: 1,
      reviews: []
    });

    const report = await service.reconcile(10);
    expect(report.processedCount).toBe(1);
    expect(report.consistentCount).toBe(0);
    expect(report.discrepancies.length).toBe(1);
    expect(report.discrepancies[0]).toEqual(expect.objectContaining({
      targetId,
      issue: 'score_mismatch'
    }));
  });

  it('handles large dataset (batching)', async () => {
    // Generate 150 ids
    const targetIds = Array.from({ length: 150 }, () => randomUUID());
    
    // Batch size of 50
    repository.getDistinctTargetIdPage
      .mockReturnValueOnce(targetIds.slice(0, 50))
      .mockReturnValueOnce(targetIds.slice(50, 100))
      .mockReturnValueOnce(targetIds.slice(100, 150))
      .mockReturnValueOnce([]);

    (ReputationService.getProfile as jest.Mock).mockReturnValue({
      score: 4.5,
      weightedScore: 4.0
    });

    client.getProfile.mockResolvedValue({
      freelancerId: 'any',
      score: 4.5,
      weightedScore: 4.0,
      totalRatings: 1,
      reviews: []
    });

    const report = await service.reconcile(50);
    expect(report.processedCount).toBe(150);
    expect(report.consistentCount).toBe(150);
    expect(report.discrepancies.length).toBe(0);
    expect(repository.getDistinctTargetIdPage).toHaveBeenCalledTimes(4);
    expect(client.getProfile).toHaveBeenCalledTimes(150);
  });

  it('handles reconciliation rerun idempotently', async () => {
    const targetId = randomUUID();
    
    // First run
    repository.getDistinctTargetIdPage.mockReturnValueOnce([targetId]).mockReturnValueOnce([]);
    (ReputationService.getProfile as jest.Mock).mockReturnValue({
      score: 4.5,
      weightedScore: 4.0
    });
    client.getProfile.mockResolvedValue({
      freelancerId: targetId,
      score: 4.5,
      weightedScore: 4.0,
      totalRatings: 1,
      reviews: []
    });

    const report1 = await service.reconcile(10);
    expect(report1.consistentCount).toBe(1);

    // Second run with same data
    repository.getDistinctTargetIdPage.mockReturnValueOnce([targetId]).mockReturnValueOnce([]);
    const report2 = await service.reconcile(10);
    expect(report2.consistentCount).toBe(1);
    expect(report1.id).not.toBe(report2.id); // Different report ID but same result
  });
});
