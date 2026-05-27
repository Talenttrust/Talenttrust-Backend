/**
 * @title Reputation Checkpoint Store
 * @dev NatSpec: Persistent storage for reputation recompute job checkpoints.
 * Allows safe resumption of recompute jobs after failures.
 */

export interface RecomputeCheckpoint {
  jobId: string;
  lastProcessedFreelancerId?: string;
  totalProcessed: number;
  totalFreelancers: number;
  startTime: string;
  lastUpdateTime: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  error?: string;
}

/**
 * Checkpoint Store for Reputation Recompute Jobs
 * 
 * Provides persistent storage for tracking progress of reputation recompute jobs.
 * Enables resuming from specific points to avoid repeated full recomputes.
 */
class ReputationCheckpointStore {
  private checkpoints: Map<string, RecomputeCheckpoint>;

  constructor() {
    this.checkpoints = new Map<string, RecomputeCheckpoint>();
  }

  /**
   * @notice Create a new checkpoint for a recompute job
   * @param jobId The unique identifier for the recompute job
   * @param totalFreelancers Total number of freelancers to process
   * @return The created checkpoint
   */
  public createCheckpoint(jobId: string, totalFreelancers: number): RecomputeCheckpoint {
    const checkpoint: RecomputeCheckpoint = {
      jobId,
      totalProcessed: 0,
      totalFreelancers,
      startTime: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString(),
      status: 'running',
    };

    this.checkpoints.set(jobId, checkpoint);
    return checkpoint;
  }

  /**
   * @notice Get a checkpoint by job ID
   * @param jobId The recompute job identifier
   * @return The checkpoint if found, otherwise undefined
   */
  public getCheckpoint(jobId: string): RecomputeCheckpoint | undefined {
    return this.checkpoints.get(jobId);
  }

  /**
   * @notice Update checkpoint progress
   * @param jobId The recompute job identifier
   * @param lastProcessedFreelancerId The ID of the last successfully processed freelancer
   * @return The updated checkpoint
   */
  public updateProgress(
    jobId: string,
    lastProcessedFreelancerId: string
  ): RecomputeCheckpoint {
    const checkpoint = this.checkpoints.get(jobId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found for job: ${jobId}`);
    }

    checkpoint.lastProcessedFreelancerId = lastProcessedFreelancerId;
    checkpoint.totalProcessed += 1;
    checkpoint.lastUpdateTime = new Date().toISOString();

    this.checkpoints.set(jobId, checkpoint);
    return checkpoint;
  }

  /**
   * @notice Mark checkpoint as completed
   * @param jobId The recompute job identifier
   * @return The updated checkpoint
   */
  public markCompleted(jobId: string): RecomputeCheckpoint {
    const checkpoint = this.checkpoints.get(jobId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found for job: ${jobId}`);
    }

    checkpoint.status = 'completed';
    checkpoint.lastUpdateTime = new Date().toISOString();

    this.checkpoints.set(jobId, checkpoint);
    return checkpoint;
  }

  /**
   * @notice Mark checkpoint as failed
   * @param jobId The recompute job identifier
   * @param error The error message describing the failure
   * @return The updated checkpoint
   */
  public markFailed(jobId: string, error: string): RecomputeCheckpoint {
    const checkpoint = this.checkpoints.get(jobId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found for job: ${jobId}`);
    }

    checkpoint.status = 'failed';
    checkpoint.error = error;
    checkpoint.lastUpdateTime = new Date().toISOString();

    this.checkpoints.set(jobId, checkpoint);
    return checkpoint;
  }

  /**
   * @notice Delete a checkpoint (cleanup after completion)
   * @param jobId The recompute job identifier
   */
  public deleteCheckpoint(jobId: string): void {
    this.checkpoints.delete(jobId);
  }

  /**
   * @notice Get all active checkpoints
   * @return Array of running or paused checkpoints
   */
  public getActiveCheckpoints(): RecomputeCheckpoint[] {
    return Array.from(this.checkpoints.values()).filter(
      cp => cp.status === 'running' || cp.status === 'paused'
    );
  }

  /**
   * @notice Check if a checkpoint exists for a job
   * @param jobId The recompute job identifier
   * @return True if checkpoint exists, else false
   */
  public hasCheckpoint(jobId: string): boolean {
    return this.checkpoints.has(jobId);
  }

  /**
   * @notice Clear all checkpoints (useful for tests)
   */
  public clear(): void {
    this.checkpoints.clear();
  }
}

// Export a singleton instance for simplicity
export const reputationCheckpointStore = new ReputationCheckpointStore();
