/**
 * Reputation Recompute Processor
 *
 * Handles periodic recomputation of reputation scores with checkpointing.
 * Subject IDs are streamed in pages from the database so the job never loads
 * the entire table into memory at once.
 */

import { ReputationRecomputePayload, JobResult } from "../types";
import { ReputationService } from "../../services/reputation.service";
import { reputationStore } from "../../models/reputation.store";
import {
  reputationCheckpointStore,
  RecomputeCheckpoint,
} from "../../models/reputation-checkpoint.store";
import { ReputationRepository } from "../../repositories/reputationRepository";
import { createLogger } from "../../logger";

/**
 * Async generator that yields one page of distinct target IDs at a time from
 * the reputation_entries table, stopping when the repository returns an empty page.
 *
 * @param repo      - Instantiated ReputationRepository.
 * @param pageSize  - Rows per page (matches job batchSize).
 */
async function* targetIdPages(
  repo: ReputationRepository,
  pageSize: number,
): AsyncGenerator<string[]> {
  let pageNumber = 0;
  while (true) {
    const offset = pageNumber * pageSize;
    const page = repo.getDistinctTargetIdPage(pageSize, offset);
    if (page.length === 0) break;
    yield page;
    if (page.length < pageSize) break; // last page
    pageNumber += 1;
  }
}

/**
 * Process a reputation recompute job.
 *
 * Iterates all distinct subject IDs from the database in pages, delegates
 * score aggregation to `ReputationService.getProfile`, and persists a
 * checkpoint after every successfully processed subject. A single subject
 * failure is logged and skipped — it does not abort the batch.
 *
 * @param payload - Recompute configuration (batchSize, forceRecompute, etc.)
 * @param repo    - ReputationRepository instance; injected for testability.
 * @returns JobResult with statistics for the completed run.
 */
export async function processReputationRecompute(
  payload: ReputationRecomputePayload,
  repo: ReputationRepository,
): Promise<JobResult> {
  const jobId = `recompute-${Date.now()}`;
  const batchSize = payload.batchSize ?? 100;
  const forceRecompute = payload.forceRecompute ?? false;

  const log = createLogger({
    processor: "reputation-recompute",
    ...(payload.correlationId && { correlationId: payload.correlationId }),
    ...(payload.requestId && { requestId: payload.requestId }),
  });

  log.info("Starting reputation recompute job", { jobId });

  // --- checkpoint wiring ---
  let checkpoint: RecomputeCheckpoint | undefined;
  if (payload.resumeFromCheckpoint !== false) {
    const active = reputationCheckpointStore.getActiveCheckpoints();
    checkpoint =
      active.length > 0
        ? active[0]
        : reputationCheckpointStore.createCheckpoint(jobId, 0);
  } else {
    checkpoint = reputationCheckpointStore.createCheckpoint(jobId, 0);
  }

  let totalProcessed = 0;
  let hasAnyId = false;

  for await (const page of targetIdPages(repo, batchSize)) {
    hasAnyId = true;

    for (const targetId of page) {
      try {
        const profile = ReputationService.getProfile(targetId);

        if (!forceRecompute && isProfileUpToDate(profile.lastUpdated)) {
          log.info("Profile up to date, skipping", { targetId });
          continue;
        }

        // Persist the freshly computed profile back to the in-memory store
        reputationStore.set(profile);
        totalProcessed++;

        reputationCheckpointStore.updateProgress(checkpoint.jobId, targetId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("Failed to recompute reputation for subject; skipping", {
          msg,
        });
        // per-subject isolation — continue with next subject
      }
    }

    log.info("Batch processed", { totalProcessed });
  }

  if (!hasAnyId) {
    log.info("No subjects found to recompute");
    reputationCheckpointStore.markCompleted(checkpoint.jobId);
    return {
      success: true,
      message: "No freelancers found to recompute",
      data: { totalProcessed: 0, totalFreelancers: 0 },
    };
  }

  reputationCheckpointStore.markCompleted(checkpoint.jobId);
  log.info("Reputation recompute job completed", { jobId, totalProcessed });

  return {
    success: true,
    message: `Successfully recomputed reputation for ${totalProcessed} freelancers`,
    data: {
      totalProcessed,
      jobId,
      checkpointId: checkpoint.jobId,
    },
  };
}

/**
 * Returns true when a profile's `lastUpdated` timestamp is within the last 24 h,
 * meaning a recompute can be skipped unless `forceRecompute` is set.
 */
function isProfileUpToDate(lastUpdated: string): boolean {
  const ageMs = Date.now() - new Date(lastUpdated).getTime();
  return ageMs < 24 * 60 * 60 * 1000;
}
