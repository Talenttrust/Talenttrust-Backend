/**
 * @module finality/policy
 * @description Per-network finality policy: configuration parsing and
 *              pure finality evaluation.
 *
 * The policy answers a single question: has an event observed at
 * `ledger` on `network` accumulated enough confirmations against the
 * current chain head to be treated as settled?
 *
 * Fail-closed principles:
 * - Unknown networks fall back to a conservative `defaultDepth` instead
 *   of being treated as instantly final.
 * - When the chain head cannot be determined, the event stays
 *   `provisional` (never exposed).
 * - When the observed head is BEHIND the event ledger (provider lag or
 *   a reorg), the event stays `provisional`.
 * - Off-chain events (no ledger) carry no on-chain finality risk and
 *   are treated as finalized immediately.
 *
 * Zero-confirmation mode (depth 0) is only honoured when
 * `allowZeroConfirmation` is true (the default outside production, so
 * local development does not require an RPC head). When zero
 * confirmations are not permitted, a configured depth of 0 is clamped
 * to 1 at policy creation time.
 */

import { FinalityEvaluation, FinalityStatus } from './types';

/**
 * Effective per-network finality policy.
 */
export interface NetworkFinalityPolicy {
  /** Map of network name -> required confirmations (depth). */
  depths: Record<string, number>;
  /**
   * Depth applied to networks without an explicit entry. Conservative
   * by default (6) so an unconfigured network is never exposed early.
   */
  defaultDepth: number;
  /**
   * When true, a depth of 0 is honoured (zero-confirmation). When
   * false, any configured depth of 0 is clamped to 1 at creation time.
   * Defaults to `true` outside production (development/test convenience)
   * and `false` in production.
   */
  allowZeroConfirmation: boolean;
}

/**
 * Inputs for a pure finality evaluation.
 */
export interface FinalityInput {
  network?: string;
  ledger?: number;
  headLedger?: number;
}

/** Result of resolving the depth for a network. */
export interface DepthResolution {
  depth: number;
  /** Whether the network had an explicit policy entry. */
  known: boolean;
}

/** Parsed representation of the `FINALITY_DEPTHS` environment variable. */
export interface FinalityEnvConfig {
  depths: Record<string, number>;
  defaultDepth: number;
  allowZeroConfirmation?: boolean;
}

/** Default depth for unknown networks — conservative, fail-closed. */
export const DEFAULT_FINALITY_DEPTH = 6;

/** Default explicit depths for the built-in networks. */
export const DEFAULT_FINALITY_DEPTHS: Record<string, number> = {
  stellar: 1,
  soroban: 1,
};

const DEPTH_PAIR_SEPARATOR = ',';
const DEPTH_KEY_VALUE_SEPARATOR = '=';

/**
 * Parse the `FINALITY_DEPTHS` env value (`network=depth,network=depth`).
 *
 * @throws Error on malformed input so configuration fails fast.
 */
export function parseFinalityDepths(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.trim() === '') {
    return { ...DEFAULT_FINALITY_DEPTHS };
  }

  const depths: Record<string, number> = {};
  for (const chunk of raw.split(DEPTH_PAIR_SEPARATOR)) {
    const pair = chunk.trim();
    if (pair.length === 0) continue;

    const separatorIndex = pair.indexOf(DEPTH_KEY_VALUE_SEPARATOR);
    if (separatorIndex <= 0 || separatorIndex === pair.length - 1) {
      throw new Error(
        `FINALITY_DEPTHS entry "${pair}" is malformed; expected "network=depth"`,
      );
    }

    const network = pair.slice(0, separatorIndex).trim();
    const depth = Number(pair.slice(separatorIndex + 1).trim());
    if (network.length === 0 || !Number.isInteger(depth) || depth < 0) {
      throw new Error(
        `FINALITY_DEPTHS entry "${pair}" is invalid; depth must be a non-negative integer`,
      );
    }

    depths[network] = depth;
  }

  return depths;
}

/**
 * Build a {@link NetworkFinalityPolicy} from environment-derived values.
 *
 * @param config - Parsed env values (depths map, default depth, and
 *                 optional explicit zero-confirmation flag).
 * @param nodeEnv - Runtime environment; when `allowZeroConfirmation` is
 *                  not explicitly set, zero-confirmation is permitted
 *                  everywhere except `production`.
 * @param logWarning - Optional hook to surface the zero-confirmation
 *                     clamp (used to emit a structured warn log).
 */
export function createFinalityPolicy(
  config: FinalityEnvConfig,
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
  logWarning?: (message: string, extra: Record<string, unknown>) => void,
): NetworkFinalityPolicy {
  const allowZeroConfirmation =
    config.allowZeroConfirmation ?? nodeEnv !== 'production';

  const depths: Record<string, number> = {};
  for (const [network, depth] of Object.entries(config.depths)) {
    if (depth === 0 && !allowZeroConfirmation) {
      if (logWarning) {
        logWarning('Finality policy: zero-confirmation depth clamped to 1', {
          network,
        });
      }
      depths[network] = 1;
    } else {
      depths[network] = depth;
    }
  }

  let defaultDepth = config.defaultDepth;
  if (defaultDepth === 0 && !allowZeroConfirmation) {
    if (logWarning) {
      logWarning('Finality policy: zero-confirmation default depth clamped to 1', {});
    }
    defaultDepth = 1;
  }

  return {
    depths,
    defaultDepth,
    allowZeroConfirmation,
  };
}

/**
 * Resolve the effective depth for a network.
 *
 * Unknown networks fall back to `defaultDepth` (fail-closed) and report
 * `known: false` so callers can emit an explicit warning.
 */
export function getFinalityDepth(
  policy: NetworkFinalityPolicy,
  network: string | undefined,
): DepthResolution {
  if (network !== undefined && hasOwn(policy.depths, network)) {
    return { depth: policy.depths[network], known: true };
  }
  return { depth: policy.defaultDepth, known: false };
}

/**
 * Pure finality evaluation. Never throws, never performs I/O.
 *
 * @see {@link FinalityInput} for accepted shapes.
 */
export function evaluateFinality(
  policy: NetworkFinalityPolicy,
  input: FinalityInput,
): FinalityEvaluation {
  const { depth } = getFinalityDepth(policy, input.network);

  // Off-chain event — no ledger to confirm; no finality risk.
  if (input.ledger === undefined) {
    return { status: 'finalized', confirmations: 0, depth: 0 };
  }

  // Zero-confirmation mode: the event is trusted as observed without
  // waiting for confirmations (development / explicitly configured).
  if (depth === 0 && policy.allowZeroConfirmation) {
    return {
      status: 'finalized',
      confirmations: 0,
      depth,
      network: input.network,
      ledger: input.ledger,
    };
  }

  // No chain head available — fail closed.
  if (input.headLedger === undefined) {
    return {
      status: 'provisional',
      confirmations: 0,
      depth,
      network: input.network,
      ledger: input.ledger,
      reason: 'head_unavailable',
    };
  }

  // Head behind the event ledger — provider lag or an active reorg.
  if (input.headLedger < input.ledger) {
    return {
      status: 'provisional',
      confirmations: 0,
      depth,
      network: input.network,
      ledger: input.ledger,
      headLedger: input.headLedger,
      reason: 'provider_lag',
    };
  }

  const confirmations = input.headLedger - input.ledger + 1;
  const status: FinalityStatus =
    confirmations >= depth ? 'finalized' : 'provisional';

  return {
    status,
    confirmations,
    depth,
    network: input.network,
    ledger: input.ledger,
    headLedger: input.headLedger,
    ...(status === 'provisional' && { reason: 'pending_confirmations' }),
  };
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
