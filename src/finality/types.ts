/**
 * @module finality/types
 * @description Shared types for blockchain finality evaluation.
 *
 * The finality layer decides whether a contract event has accumulated
 * enough on-chain confirmations to be treated as settled. Events that
 * have NOT reached the configured network finality depth are marked
 * `provisional` internally and are hidden from public reads, so
 * consumers never observe a release (e.g. `MILESTONE_RELEASED`) before
 * it is safe, and never receive contradictory state after a reorg.
 */

/**
 * Internal finality state of a persisted event.
 *
 * - `finalized`: the event has accumulated at least the configured
 *   confirmations (or is off-chain / zero-confirmation). It may be
 *   exposed through public reads.
 * - `provisional`: the event has been observed but not yet confirmed
 *   to the network's finality depth. It is stored for auditability but
 *   MUST NOT be exposed through public reads.
 *
 * @dev Promotion is one-way (`provisional` -> `finalized`): a
 *      finalized event is never demoted, so a reorg that is deeper than
 *      the configured depth cannot flip previously published state.
 */
export type FinalityStatus = 'finalized' | 'provisional';

/**
 * Machine-readable reason for a provisional (fail-closed) outcome.
 * Present on evaluations that are not finalized.
 */
export type FinalityReason =
  | 'pending_confirmations'
  | 'provider_lag'
  | 'provider_unavailable'
  | 'head_unavailable'
  | 'network_missing';

/**
 * Pure evaluation result — no side effects.
 */
export interface FinalityEvaluation {
  status: FinalityStatus;
  /** Number of confirmations the event has accumulated (0 when unknown). */
  confirmations: number;
  /** Effective finality depth applied for the event's network. */
  depth: number;
  network?: string;
  ledger?: number;
  headLedger?: number;
  reason?: FinalityReason;
}
