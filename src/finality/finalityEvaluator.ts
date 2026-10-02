/**
 * @module finality/finalityEvaluator
 * @description Async finality evaluator with an injectable chain-head
 *              provider and fail-closed error handling.
 *
 * The evaluator bridges the pure {@link evaluateFinality} policy with
 * the live network: it fetches the current chain head from a
 * {@link LatestLedgerProvider} and applies the policy.
 *
 * Failure handling is explicit and bounded:
 * - Provider errors never throw out of `evaluate` — the event is marked
 *   `provisional` (fail-closed) and a structured warn record is emitted.
 * - Zero-confirmation and off-chain events never touch the provider.
 * - Unknown networks emit a warn record and use the conservative
 *   default depth.
 *
 * The provider is deliberately a plain async function so tests can stub
 * it and production can wrap any RPC client (see `providers.ts`).
 */

import { createLogger, Logger } from '../logger';
import {
  evaluateFinality,
  FinalityInput,
  getFinalityDepth,
  NetworkFinalityPolicy,
} from './policy';
import { FinalityEvaluation } from './types';

/**
 * Resolves the current chain head (latest ledger/block sequence) for a
 * network. Rejects on provider failure.
 */
export type LatestLedgerProvider = (network: string) => Promise<number>;

/** Safe structured representation of a provider error (no stack leak). */
function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown provider error';
}

export class FinalityEvaluator {
  constructor(
    private readonly policy: NetworkFinalityPolicy,
    private readonly getLatestLedger: LatestLedgerProvider,
    private readonly log: Logger = createLogger({ service: 'finality' }),
  ) {}

  /**
   * Fetch the current chain head for a network. Rejects on provider
   * failure; callers that must fail closed should use {@link evaluate}.
   */
  public async getLatestHead(network: string): Promise<number> {
    return this.getLatestLedger(network);
  }

  /**
   * Evaluate an event's finality, fetching the chain head when needed.
   *
   * Never throws for provider failures — the event is marked
   * `provisional` (fail-closed) so unconfirmed state is never exposed.
   */
  public async evaluate(input: FinalityInput): Promise<FinalityEvaluation> {
    // Off-chain events need no head.
    if (input.ledger === undefined) {
      return evaluateFinality(this.policy, input);
    }

    const { depth, known } = getFinalityDepth(this.policy, input.network);

    // Zero-confirmation mode: trusted as observed, no head required.
    if (depth === 0 && this.policy.allowZeroConfirmation) {
      return evaluateFinality(this.policy, input);
    }

    // On-chain event without a network cannot be attributed to a head —
    // fail closed rather than risk exposing unconfirmed state.
    if (input.network === undefined) {
      this.log.warn(
        'Finality evaluation: on-chain event missing network; marking provisional',
        { ledger: input.ledger },
      );
      return {
        status: 'provisional',
        confirmations: 0,
        depth,
        ledger: input.ledger,
        reason: 'network_missing',
      };
    }

    if (!known) {
      this.log.warn(
        'Finality evaluation: no policy for network; applying conservative default depth',
        { network: input.network, defaultDepth: depth },
      );
    }

    let headLedger: number;
    try {
      headLedger = await this.getLatestLedger(input.network);
    } catch (error) {
      // Fail closed — never expose unconfirmed state when the head is
      // unknown. The event stays provisional until a later evaluation
      // (e.g. the next blockchain-sync promotion sweep) succeeds.
      this.log.warn(
        'Finality evaluation: chain head unavailable; marking event provisional',
        { network: input.network, error: safeErrorMessage(error) },
      );
      return {
        status: 'provisional',
        confirmations: 0,
        depth,
        network: input.network,
        ledger: input.ledger,
        reason: 'provider_unavailable',
      };
    }

    return evaluateFinality(this.policy, {
      network: input.network,
      ledger: input.ledger,
      headLedger,
    });
  }

  /**
   * Evaluate against a caller-supplied head (used by the promotion
   * sweep so one head fetch serves the whole batch). Pure aside from
   * unknown-network logging.
   */
  public evaluateWithHead(
    input: FinalityInput,
    headLedger: number,
  ): FinalityEvaluation {
    if (input.network !== undefined) {
      const resolution = getFinalityDepth(this.policy, input.network);
      if (!resolution.known) {
        this.log.warn(
          'Finality evaluation: no policy for network; applying conservative default depth',
          { network: input.network, defaultDepth: resolution.depth },
        );
      }
    }
    return evaluateFinality(this.policy, { ...input, headLedger });
  }
}
