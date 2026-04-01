/**
 * Job Processors Index
 * 
 * Aggregates all job processors and exports a unified processor map.
 * Each processor handles a specific job type.
 */

import { JobType, JobPayload, JobResult } from '../types';
import { processEmailNotification } from './email-processor';
import { processContractProcessing } from './contract-processor';
import { processReputationUpdate } from './reputation-processor';
import { processBlockchainSync } from './blockchain-processor';

/**
 * Type-safe processor function signature
 */
export type JobProcessor = (payload: JobPayload) => Promise<JobResult>;

/**
 * Map of job types to their processor functions
 * Ensures all job types have a corresponding processor
 */
export const jobProcessors: Record<JobType, JobProcessor> = {
  [JobType.EMAIL_NOTIFICATION]: processEmailNotification,
  [JobType.CONTRACT_PROCESSING]: processContractProcessing,
  [JobType.REPUTATION_UPDATE]: processReputationUpdate,
  [JobType.BLOCKCHAIN_SYNC]: processBlockchainSync,
};
