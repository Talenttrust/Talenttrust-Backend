/**
 * Queue Job Type Definitions
 * 
 * Defines the structure and types for all background jobs in the system.
 * Each job type has a specific payload structure for type safety.
 */

/**
 * Available job types in the system
 */
export enum JobType {
  EMAIL_NOTIFICATION = 'email-notification',
  CONTRACT_PROCESSING = 'contract-processing',
  REPUTATION_UPDATE = 'reputation-update',
  REPUTATION_RECOMPUTE = 'reputation-recompute',
  BLOCKCHAIN_SYNC = 'blockchain-sync',
}

/**
 * Email notification job payload
 */
export interface EmailNotificationPayload {
  to: string;
  subject: string;
  body: string;
  templateId?: string;
  correlationId?: string;
  requestId?: string;
}

/**
 * Contract processing job payload
 */
export interface ContractProcessingPayload {
  contractId: string;
  action: 'create' | 'update' | 'finalize';
  metadata?: Record<string, unknown>;
  correlationId?: string;
  requestId?: string;
}

/**
 * Reputation update job payload
 */
export interface ReputationUpdatePayload {
  userId: string;
  contractId: string;
  rating: number;
  feedback?: string;
  correlationId?: string;
  requestId?: string;
}

/**
 * Reputation recompute job payload
 */
export interface ReputationRecomputePayload {
  batchSize?: number;
  forceRecompute?: boolean;
  resumeFromCheckpoint?: boolean;
  correlationId?: string;
  requestId?: string;
}

/**
 * Blockchain synchronization job payload
 */
export interface BlockchainSyncPayload {
  network: 'stellar' | 'soroban';
  startBlock?: number;
  endBlock?: number;
  correlationId?: string;
  requestId?: string;
}

/**
 * Union type for all job payloads
 */
export type JobPayload =
  | EmailNotificationPayload
  | ContractProcessingPayload
  | ReputationUpdatePayload
  | ReputationRecomputePayload
  | BlockchainSyncPayload;

export interface JobEnqueueOptions {
  priority?: number;
  delay?: number;
  jobId?: string;
  attempts?: number;
  backoff?: {
    type: 'fixed' | 'exponential';
    delay: number;
  };
}

export interface FailedJobEntry {
  jobId: string;
  jobType: JobType;
  name: string;
  data: JobPayload;
  failedReason: string | null;
  attemptsMade: number;
  finishedOn: number | null;
  timestamp: number;
  replayDeduplicationKey: string;
}

export interface FailedJobQuery {
  jobType?: JobType;
  limit?: number;
  offset?: number;
}

export interface ReplayJobResult {
  replayJobId: string;
  deduplicated: boolean;
  originalJobId: string;
  jobType: JobType;
}

/**
 * Job result structure
 */
export interface JobResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

/**
 * Options for addJob — extends base scheduling options with deduplication support.
 * When dedupeKey is provided, BullMQ will not create a new job if one with the
 * same key is already waiting, active, or delayed. Optionally, dedupeTtl keeps
 * the key alive after completion so re-enqueue is suppressed during that window.
 */
export interface AddJobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  dedupeKey?: string;
  dedupeTtl?: number;
}

/**
 * Return value of addJob — includes whether the call hit an existing job.
 */
export interface AddJobResult {
  jobId: string;
  deduplicated: boolean;
}
