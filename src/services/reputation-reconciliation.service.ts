import { ReputationRepository } from '../repositories/reputationRepository';
import { ReputationClient, ReputationError } from '../dependencies/reputationClient';
import { ReputationService } from './reputation.service';
import { logger } from '../logger';
import { randomUUID } from 'crypto';

export interface ReconciliationDiscrepancy {
  targetId: string;
  issue: 'missing_upstream' | 'score_mismatch';
  localScore: number;
  upstreamScore?: number;
  localWeightedScore: number;
  upstreamWeightedScore?: number;
}

export interface ReconciliationReport {
  id: string;
  timestamp: string;
  processedCount: number;
  consistentCount: number;
  discrepancies: ReconciliationDiscrepancy[];
}

export class ReputationReconciliationService {
  constructor(
    private readonly repository: ReputationRepository,
    private readonly client: ReputationClient,
  ) {}

  /**
   * Compares stable identifiers and scores in bounded batches.
   * Emits a deterministic difference report.
   * Read-only and repeatable.
   */
  public async reconcile(batchSize: number = 50): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      processedCount: 0,
      consistentCount: 0,
      discrepancies: [],
    };

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const targetIds = this.repository.getDistinctTargetIdPage(batchSize, offset);
      if (targetIds.length === 0) {
        hasMore = false;
        break;
      }

      for (const targetId of targetIds) {
        report.processedCount++;
        
        try {
          // Local score computation
          const localProfile = ReputationService.getProfile(targetId);
          
          let upstreamProfile;
          try {
            upstreamProfile = await this.client.getProfile(targetId);
          } catch (error: any) {
             if (error instanceof ReputationError && error.status === 404) {
               report.discrepancies.push({
                 targetId,
                 issue: 'missing_upstream',
                 localScore: localProfile.score,
                 localWeightedScore: localProfile.weightedScore,
               });
               continue;
             }
             logger.error('reconciliation_upstream_error', {
               targetId,
               error: error.message
             });
             throw error;
          }

          const SCORE_TOLERANCE = 0.001; // Floating point tolerance

          const isScoreMatch = Math.abs(localProfile.score - upstreamProfile.score) < SCORE_TOLERANCE;
          const isWeightedScoreMatch = Math.abs(localProfile.weightedScore - upstreamProfile.weightedScore) < SCORE_TOLERANCE;

          if (!isScoreMatch || !isWeightedScoreMatch) {
            report.discrepancies.push({
              targetId,
              issue: 'score_mismatch',
              localScore: localProfile.score,
              upstreamScore: upstreamProfile.score,
              localWeightedScore: localProfile.weightedScore,
              upstreamWeightedScore: upstreamProfile.weightedScore,
            });
          } else {
            report.consistentCount++;
          }
        } catch (error: any) {
          logger.error('reconciliation_processing_error', {
            targetId,
            error: error.message
          });
          throw error;
        }
      }
      
      offset += batchSize;
    }

    logger.info('reputation_reconciliation_completed', {
      reportId: report.id,
      processedCount: report.processedCount,
      consistentCount: report.consistentCount,
      discrepancyCount: report.discrepancies.length,
    });

    return report;
  }
}
