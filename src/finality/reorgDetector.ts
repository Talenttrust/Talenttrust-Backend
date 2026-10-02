/**
 * @module finality/reorgDetector
 * @description Pure, side-effect-free reorg detection and rewind-bounded
 *              evaluation.
 *
 * A chain reorganization (reorg) is detected when the reported chain head
 * moves *backwards* compared to the last known good head. This module:
 *
 * 1. Detects whether a reorg occurred between two head values.
 * 2. Computes the rewind depth (how far back the head regressed).
 * 3. Enforces a maximum rewind window so that reorgs exceeding a
 *    configurable depth are rejected (the system fails closed).
 * 4. Provides a pure evaluation path that callers use to decide whether
 *    to trigger the rewind service before ingesting new events.
 *
 * The module is deliberately free of I/O — all chain-head values arrive as
 * plain numbers so tests can exercise every edge case synchronously.
 */

/** Result of evaluating whether a reorg occurred between two heads. */
export interface ReorgEvaluation {
  /** Whether a reorg was detected (current head < previous head). */
  detected: boolean;
  /**
   * Depth of the reorg in ledgers. When `detected` is false this is 0.
   * When `detected` is true this is `previousHead - currentHead`.
   */
  depth: number;
  /**
   * The ledger from which rewind should begin — the new (reorged) head.
   * Undefined when no reorg is detected.
   */
  rewindFromLedger?: number;
  /**
   * Whether the reorg exceeds the configured maximum rewind window.
   * When true the caller MUST NOT proceed and should fail closed.
   */
  exceedsRetentionPolicy: boolean;
}

/** Configuration for the reorg detector. */
export interface ReorgDetectorConfig {
  /**
   * Maximum number of ledgers that may be rewound.  A reorg deeper than
   * this is rejected so the system never attempts an unbounded rollback.
   * Must be a positive integer.
   */
  maxRewindDepth: number;
}

/**
 * Evaluate whether a chain reorg has occurred between two successive head
 * ledger values.
 *
 * Pure — no I/O, no logging, no side effects.
 *
 * @param previousHead - The last known good chain head (the highest ledger
 *   we have indexed from). Must be a non-negative integer.
 * @param currentHead  - The chain head reported by the RPC on the current
 *   sync. Must be a non-negative integer.
 * @param config       - Detector configuration (max rewind depth).
 * @returns A fully deterministic {@link ReorgEvaluation}.
 * @throws {Error} When either head is negative or non-integer, or when
 *   config is invalid.
 */
export function evaluateReorg(
  previousHead: number,
  currentHead: number,
  config: ReorgDetectorConfig,
): ReorgEvaluation {
  // ── input validation ──────────────────────────────────────────────
  if (!Number.isInteger(previousHead) || previousHead < 0) {
    throw new Error(
      `previousHead must be a non-negative integer; received ${previousHead}`,
    );
  }
  if (!Number.isInteger(currentHead) || currentHead < 0) {
    throw new Error(
      `currentHead must be a non-negative integer; received ${currentHead}`,
    );
  }
  if (
    !Number.isInteger(config.maxRewindDepth) ||
    config.maxRewindDepth <= 0
  ) {
    throw new Error(
      `maxRewindDepth must be a positive integer; received ${config.maxRewindDepth}`,
    );
  }

  // ── no reorg ─────────────────────────────────────────────────────
  if (currentHead >= previousHead) {
    return {
      detected: false,
      depth: 0,
      exceedsRetentionPolicy: false,
    };
  }

  // ── reorg detected ───────────────────────────────────────────────
  const depth = previousHead - currentHead;
  const exceedsRetentionPolicy = depth > config.maxRewindDepth;

  return {
    detected: true,
    depth,
    rewindFromLedger: currentHead,
    exceedsRetentionPolicy,
  };
}
