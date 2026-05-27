/**
 * Reputation Recompute Processor
 * 
 * Handles periodic recomputation of reputation scores with checkpointing.
 * Processes freelancers in batches and can resume safely after failures.
 */

import { ReputationRecomputePayload, JobResult } from '../types';
import { reputationStore } from '../../models/reputation.store';
import { ReputationService } from '../../services/reputation.service';
import { reputationCheckpointStore, RecomputeCheckpoint } from '../../models/reputation-checkpoint.store';
import { logger } from '../../logger';

/**
 * Process reputation recompute job
 * 
 * @param payload - Reputation recompute configuration
 * @returns Job result with recompute statistics
 * @throws Error if validation fails
 */
export async function processReputationRecompute(
  payload: ReputationRecomputePayload
): Promise<JobResult> {
  const jobId = `recompute-${Date.now()}`;
  const batchSize = payload.batchSize || 100;
  const forceRecompute = payload.forceRecompute || false;
  const resumeFromCheckpoint = payload.resumeFromCheckpoint !== false;

  logger.info(`Starting reputation recompute job ${jobId}`);

  try {
    // Get all freelancer IDs from the reputation store
    const allFreelancerIds = getAllFreelancerIds();
    const totalFreelancers = allFreelancerIds.length;

    if (totalFreelancers === 0) {
      logger.info('No freelancers found to recompute');
      return {
        success: true,
        message: 'No freelancers found to recompute',
        data: { totalProcessed: 0, totalFreelancers: 0 },
      };
    }

    // Check for existing checkpoint if resume is enabled
    let checkpoint: RecomputeCheckpoint | undefined;
    let startIndex = 0;

    if (resumeFromCheckpoint) {
      const activeCheckpoints = reputationCheckpointStore.getActiveCheckpoints();
      if (activeCheckpoints.length > 0) {
        checkpoint = activeCheckpoints[0];
        logger.info(`Resuming from checkpoint: ${checkpoint.jobId}`);
        
        // Find the index of the last processed freelancer
        if (checkpoint.lastProcessedFreelancerId) {
          startIndex = allFreelancerIds.indexOf(checkpoint.lastProcessedFreelancerId) + 1;
        }
      } else {
        // Create new checkpoint
        checkpoint = reputationCheckpointStore.createCheckpoint(jobId, totalFreelancers);
      }
    } else {
      // Create new checkpoint
      checkpoint = reputationCheckpointStore.createCheckpoint(jobId, totalFreelancers);
    }

    // Process freelancers in batches
    let processedCount = checkpoint ? checkpoint.totalProcessed : 0;
    let lastProcessedId: string | undefined;

    for (let i = startIndex; i < allFreelancerIds.length; i += batchSize) {
      const batch = allFreelancerIds.slice(i, i + batchSize);
      
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1}: ${batch.length} freelancers`);

      // Process each freelancer in the batch
      for (const freelancerId of batch) {
        try {
          await recomputeFreelancerReputation(freelancerId, forceRecompute);
          lastProcessedId = freelancerId;
          processedCount++;

          // Update checkpoint progress
          if (checkpoint) {
            reputationCheckpointStore.updateProgress(checkpoint.jobId, freelancerId);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`Failed to recompute reputation for ${freelancerId}:`, { error: errorMessage });
          
          // Mark checkpoint as failed
          if (checkpoint) {
            reputationCheckpointStore.markFailed(checkpoint.jobId, errorMessage);
          }
          
          throw new Error(`Recompute failed for freelancer ${freelancerId}: ${errorMessage}`);
        }
      }

      // Log progress
      const progress = ((processedCount / totalFreelancers) * 100).toFixed(2);
      logger.info(`Progress: ${processedCount}/${totalFreelancers} (${progress}%)`);
    }

    // Mark checkpoint as completed
    if (checkpoint) {
      reputationCheckpointStore.markCompleted(checkpoint.jobId);
    }

    const result = {
      success: true,
      message: `Successfully recomputed reputation for ${processedCount} freelancers`,
      data: {
        totalProcessed: processedCount,
        totalFreelancers,
        jobId,
        checkpointId: checkpoint?.jobId,
      },
    };

    logger.info(`Reputation recompute job ${jobId} completed successfully`);
    return result;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Reputation recompute job ${jobId} failed:`, { error: errorMessage });
    
    return {
      success: false,
      message: `Reputation recompute failed: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

/**
 * Recompute reputation for a single freelancer
 * 
 * @param freelancerId - The freelancer identifier
 * @param forceRecompute - Whether to force recompute even if up-to-date
 */
async function recomputeFreelancerReputation(
  freelancerId: string,
  forceRecompute: boolean
): Promise<void> {
  const profile = reputationStore.get(freelancerId);
  
  if (!profile) {
    logger.info(`No profile found for freelancer ${freelancerId}, skipping`);
    return;
  }

  // Check if recompute is needed (unless forced)
  if (!forceRecompute && isProfileUpToDate(profile)) {
    logger.info(`Profile for ${freelancerId} is up to date, skipping`);
    return;
  }

  // Recalculate the reputation score based on all reviews
  if (profile.reviews.length === 0) {
    profile.score = 0.0;
    profile.totalRatings = 0;
  } else {
    const totalScore = profile.reviews.reduce((acc, review) => acc + review.rating, 0);
    profile.totalRatings = profile.reviews.length;
    profile.score = parseFloat((totalScore / profile.totalRatings).toFixed(2));
  }

  profile.lastUpdated = new Date().toISOString();
  
  // Save the updated profile
  reputationStore.set(profile);
  
  logger.info(`Recomputed reputation for ${freelancerId}: ${profile.score}`);
}

/**
 * Check if a profile is up to date
 * 
 * @param profile - The reputation profile to check
 * @returns True if profile is recent, false otherwise
 */
function isProfileUpToDate(profile: any): boolean {
  const lastUpdated = new Date(profile.lastUpdated);
  const now = new Date();
  const hoursSinceUpdate = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60);
  
  // Consider profile up to date if updated within last 24 hours
  return hoursSinceUpdate < 24;
}

/**
 * Get all freelancer IDs from the reputation store
 * 
 * @returns Array of freelancer IDs
 */
function getAllFreelancerIds(): string[] {
  // This is a mock implementation - in production, this would query the database
  const freelancerIds: string[] = [];
  
  // For now, we'll simulate some freelancer IDs
  // In a real implementation, this would query the database for all freelancer IDs
  for (let i = 1; i <= 1000; i++) {
    freelancerIds.push(`freelancer-${i}`);
  }
  
  return freelancerIds;
}
