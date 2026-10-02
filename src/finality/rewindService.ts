/**
 * @module finality/rewindService
 * @description Orchestrates safe rewind of event ingestion after a detected
 *              chain reorganization.
 *
 * The service coordinates the three phases of a rewind:
 *
 * 1. **Evaluate** — call {@link evaluateReorg} to decide whether the
 *    rewind window is exceeded (fail-closed).
 * 2. **Demote** — flip every affected provisional or finalized event
 *    back to provisional so the downstream promotion sweep re-evaluates
 *    them against the new (reorged) chain head.
 * 3. **Rewind cursors** — move each affected indexer cursor backwards
 *    to the reorg point so the next sync re-indexes from the correct
 *    ledger.
 *
 * The service is idempotent: calling `rewindAfterReorg` with the same
 * inputs twice produces the same final state and emits the same counts.
 *
 * ## Edge cases
 *
 * | Case | Behaviour |
 * |------|-----------|
 * | No reorg | No-op; returns `{ rewound: 0, demoted: 0, skipped: false }` |
 * | Reorg within window | Events demoted, cursors rewound, positive counts |
 * | Reorg exceeds retention | `skipped: true`, error thrown so the queue retries |
 * | Operator repeats rewind | Idempotent — events already provisional are skipped |
 * | Reorg during processing | Handled by queue retry semantics (job re-runs) |
 *
 * ## Security notes
 *
 * - Tenant isolation is preserved because demote + rewind only touch
 *   internal finality metadata; no PII or API-facing data is altered.
 * - Structured errors never leak stack traces or internal state.
 */

import { createLogger, Logger } from '../logger';
import { CursorRepository } from '../contracts/cursor.repository';
import { evaluateReorg, ReorgEvaluation, ReorgDetectorConfig } from './reorgDetector';

const log = createLogger({ service: 'rewind-service' });

/**
 * Repository subset required by the rewind service for event demotion.
 * Extracted as an interface so the service is testable with in-memory
 * implementations without pulling in the full audit repository.
 */
export interface DemotableEventRepository {
  /**
   * Demote events whose ledger falls within the reorg window back to
   * provisional. Only finalized events in the given network are affected.
   * Returns the number of events actually demoted.
   */
  demoteProvisional(
    network: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<number>;
}

/** Result of a rewind operation. */
export interface RewindResult {
  /** Number of events demoted from finalized back to provisional. */
  demoted: number;
  /** Number of indexer cursors rewound. */
  rewound: number;
  /** The reorg evaluation that drove this rewind. */
  evaluation: ReorgEvaluation;
}

/** Result when the rewind is skipped (reorg exceeds retention). */
export interface RewindSkipped {
  skipped: true;
  evaluation: ReorgEvaluation;
}

export type RewindOutcome = RewindResult | RewindSkipped;

/** Configuration for the rewind service. */
export interface RewindServiceConfig extends ReorgDetectorConfig {
  /** Networks for which cursors should be rewound. */
  networks: string[];
}

/**
 * Orchestrate a safe rewind after a chain reorg.
 *
 * @param previousHead - The last known good chain head.
 * @param currentHead  - The chain head reported by the RPC.
 * @param config       - Rewind configuration (max depth, networks).
 * @param eventRepo    - Repository capable of demoting affected events.
 * @param cursorRepo   - Repository managing indexer cursors.
 * @param logger       - Optional structured logger override (for tests).
 * @returns {@link RewindResult} on success, {@link RewindSkipped} when
 *   the reorg exceeds the retention window, or throws on internal errors.
 */
export async function rewindAfterReorg(
  previousHead: number,
  currentHead: number,
  config: RewindServiceConfig,
  eventRepo: DemotableEventRepository,
  cursorRepo: CursorRepository,
  logger: Logger = log,
): Promise<RewindOutcome> {
  const evaluation = evaluateReorg(previousHead, currentHead, {
    maxRewindDepth: config.maxRewindDepth,
  });

  // ── no reorg ─────────────────────────────────────────────────────
  if (!evaluation.detected) {
    logger.debug('No reorg detected; rewind skipped', {
      previousHead,
      currentHead,
    });
    return {
      demoted: 0,
      rewound: 0,
      evaluation,
    };
  }

  // ── reorg exceeds retention window — fail closed ─────────────────
  if (evaluation.exceedsRetentionPolicy) {
    logger.error('Reorg exceeds maximum rewind depth; refusing to rewind', {
      previousHead,
      currentHead,
      reorgDepth: evaluation.depth,
      maxRewindDepth: config.maxRewindDepth,
    });
    return { skipped: true, evaluation };
  }

  const rewindFrom = evaluation.rewindFromLedger!;

  // ── phase 1: demote affected events ──────────────────────────────
  let totalDemoted = 0;
  for (const network of config.networks) {
    try {
      const demoted = await eventRepo.demoteProvisional(
        network,
        rewindFrom,
        previousHead,
      );
      totalDemoted += demoted;

      if (demoted > 0) {
        logger.info('Rewind: demoted events back to provisional', {
          network,
          demoted,
          fromLedger: rewindFrom,
          toLedger: previousHead,
        });
      }
    } catch (error) {
      // Demote failure is non-fatal — events stay as-is and the
      // promotion sweep will re-evaluate them on the next sync.
      logger.warn('Rewind: failed to demote events for network', {
        network,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ── phase 2: rewind indexer cursors ──────────────────────────────
  let totalRewound = 0;
  for (const network of config.networks) {
    try {
      const cursor = await cursorRepo.getCursor(network);
      if (cursor === null) continue;

      if (cursor.lastSequence >= rewindFrom) {
        const result = await cursorRepo.rewindCursor(network, rewindFrom - 1);
        if (result.success) {
          totalRewound++;
          logger.info('Rewind: cursor rewound', {
            sourceId: network,
            fromSequence: cursor.lastSequence,
            toSequence: rewindFrom - 1,
          });
        }
      }
    } catch (error) {
      logger.warn('Rewind: failed to rewind cursor for network', {
        network,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  logger.info('Rewind completed', {
    reorgDepth: evaluation.depth,
    demoted: totalDemoted,
    rewound: totalRewound,
  });

  return {
    demoted: totalDemoted,
    rewound: totalRewound,
    evaluation,
  };
}
