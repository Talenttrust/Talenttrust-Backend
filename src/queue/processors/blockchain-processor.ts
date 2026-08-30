/**
 * Blockchain Synchronization Processor
 *
 * Handles synchronization of blockchain data with local database.
 * Processes blocks in batches to avoid overwhelming the system.
 */

import { BlockchainSyncPayload, JobResult } from '../types';
import { createLogger } from '../../logger';
import { InvalidJobPayloadError } from '../queue-errors';
import { eventAuditService } from '../../events/registry';

/**
 * Finality promotion callback invoked after a successful sync. Flips
 * provisional events that have reached the network's finality depth.
 */
export type FinalityPromoter = (
  network: string,
) => Promise<{ promoted: number; remaining: number }>;

/**
 * Default promoter backed by the shared event audit service. Idempotent
 * and safe to run on every successful sync (retries are harmless).
 */
const defaultFinalityPromoter: FinalityPromoter = (network) =>
  eventAuditService.promoteProvisionalEvents(network);

/**
 * Process blockchain synchronization job
 *
 * Lifecycle:
 * 1. Validate payload.
 * 2. Detect chain reorg by comparing the current RPC head against the
 *    last known head for this network. When a reorg is detected, invoke
 *    the wired reorg handler to rewind affected state *before*
 *    ingesting new blocks.
 * 3. Sync new blocks.
 * 4. Promote provisional events that reached finality depth.
 * 5. Record the current head for future reorg detection.
 *
 * Because promotion is one-way and idempotent, retrying the job is
 * always safe; a reorg before finality simply keeps affected events
 * provisional.
 *
 * @param payload - Blockchain sync configuration
 * @param finalityPromoter - Optional promotion callback (tests inject
 *                           their own; defaults to the registry service)
 * @returns Job result with sync statistics
 * @throws Error if sync fails (the queue retries per its policy)
 */
export async function processBlockchainSync(
  payload: BlockchainSyncPayload,
  finalityPromoter: FinalityPromoter = defaultFinalityPromoter,
): Promise<JobResult> {
  const log = createLogger({
    processor: 'blockchain',
    network: payload.network,
    ...(payload.correlationId && { correlationId: payload.correlationId }),
    ...(payload.requestId && { requestId: payload.requestId }),
  });

  // Validate network
  const validNetworks = ['stellar', 'soroban'];
  if (!validNetworks.includes(payload.network)) {
    log.warn('Blockchain sync rejected: invalid network', { network: payload.network });
    throw new InvalidJobPayloadError(`Invalid network: ${payload.network}`);
  }

  // Validate block range
  if (payload.startBlock !== undefined && payload.endBlock !== undefined) {
    if (payload.startBlock > payload.endBlock) {
      log.warn('Blockchain sync rejected: invalid block range', {
        startBlock: payload.startBlock,
        endBlock: payload.endBlock,
      });
      throw new InvalidJobPayloadError('Start block must be less than or equal to end block');
    }
  }

  log.info('Starting blockchain sync', {
    startBlock: payload.startBlock,
    endBlock: payload.endBlock,
  });

  // ── reorg detection ──────────────────────────────────────────────
  // The startBlock from the payload represents the RPC-reported head
  // at enqueue time. Compare it against the last known head we
  // recorded for this network to detect a chain reorganization.
  const currentHead = payload.startBlock ?? 0;
  const previousHead = lastKnownHeads.get(payload.network);

  if (previousHead !== undefined && currentHead < previousHead) {
    const reorgEval = evaluateReorg(previousHead, currentHead, DEFAULT_REORG_CONFIG);

    if (reorgEval.exceedsRetentionPolicy) {
      log.error('Reorg exceeds maximum rewind depth; aborting sync', {
        previousHead,
        currentHead,
        reorgDepth: reorgEval.depth,
        maxRewindDepth: DEFAULT_REORG_CONFIG.maxRewindDepth,
      });
      throw new InvalidJobPayloadError(
        `Reorg depth ${reorgEval.depth} exceeds maximum rewind depth ${DEFAULT_REORG_CONFIG.maxRewindDepth}`,
      );
    }

    log.warn('Chain reorg detected; invoking rewind handler', {
      previousHead,
      currentHead,
      reorgDepth: reorgEval.depth,
    });

    try {
      await reorgHandler(payload.network, reorgEval);
    } catch (error) {
      log.error('Blockchain sync aborted: reorg rewind failed', {
        error: error instanceof Error ? error.message : 'Unknown reorg error',
      });
      throw error;
    }
  }

  const syncResult = await syncBlockchainData(payload, log);

  // Record the current head for future reorg detection.
  lastKnownHeads.set(payload.network, syncResult.endBlock);

  // Promote provisional events that have now reached the network's
  // finality depth. Failures propagate so the queue retries the job
  // (sync is idempotent, so a retry is safe).
  let finalityPromotion: { promoted: number; remaining: number } | undefined;
  try {
    finalityPromotion = await finalityPromoter(payload.network);
    log.info('Blockchain sync: finality promotion applied', finalityPromotion);
  } catch (error) {
    log.error('Blockchain sync: finality promotion failed; will retry on next sync', {
      error: error instanceof Error ? error.message : 'Unknown promotion error',
    });
    throw error;
  }

  log.info('Blockchain sync completed', {
    blocksProcessed: syncResult.blocksProcessed,
    transactionsFound: syncResult.transactionsFound,
  });

  return {
    success: true,
    message: `Blockchain sync completed for ${payload.network}`,
    data: {
      ...syncResult,
      ...(finalityPromotion !== undefined && { finalityPromotion }),
    },
  };
}

/**
 * Sync blockchain data in batches
 */
async function syncBlockchainData(
  payload: BlockchainSyncPayload,
  log: ReturnType<typeof createLogger>,
) {
  const startBlock = payload.startBlock || 0;
  const endBlock = payload.endBlock || startBlock + 100;
  const batchSize = 10;

  let processedBlocks = 0;
  let transactions = 0;

  for (let block = startBlock; block <= endBlock; block += batchSize) {
    const batchEnd = Math.min(block + batchSize - 1, endBlock);

    await processBatch(payload.network, block, batchEnd, log);

    processedBlocks += batchEnd - block + 1;
    transactions += Math.floor(Math.random() * 50) + 10;
  }

  return {
    network: payload.network,
    blocksProcessed: processedBlocks,
    transactionsFound: transactions,
    startBlock,
    endBlock,
  };
}

/**
 * Process a batch of blocks
 */
async function processBatch(
  network: string,
  startBlock: number,
  endBlock: number,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const stepDelay = process.env.JEST_WORKER_ID ? 0 : 300;
  await new Promise((resolve) => setTimeout(resolve, stepDelay));
  log.debug('Processed block batch', { network, startBlock, endBlock });
}
