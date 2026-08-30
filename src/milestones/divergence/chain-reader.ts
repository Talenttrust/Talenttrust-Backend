/**
 * @module milestones/divergence/chain-reader
 * @description Reads canonical milestone state from the Soroban chain.
 *
 * The reader is the divergence feature's only window onto on-chain state.
 * It is intentionally narrow (read milestone state + latest ledger) and
 * never submits transactions, so the comparison job cannot mutate the chain.
 *
 * ## Failure contract
 * RPC failures propagate as classified errors (see
 * {@link classifySorobanRpcError} in `src/errors/appError.ts`). The scanner
 * decides what to do with them — per-contract failures become `unavailable`
 * reports, a head-ledger failure aborts the run for the queue to retry.
 *
 * ## On-chain layout
 * Milestone state is expected under a persistent contract-data key
 * `Milestones` whose value decodes (via `scValToNative`) to an array of
 * milestone records with fields: `milestone_id`, `title`, `description`,
 * `amount`, `deadline` (nullable), `completed`. `amount` may be encoded as a
 * string (u128) or number; normalization happens in
 * {@link normalizeMilestoneState}.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { classifySorobanRpcError } from '../../errors/appError';
import { SorobanRpcService } from '../../services/soroban/SorobanRpcService';
import type { MilestoneState } from './types';

/** Data key the TalentTrust contract stores milestone state under. */
export const MILESTONES_CONTRACT_DATA_KEY = 'Milestones';

/** Minimal surface of the Soroban RPC service the reader depends on. */
export interface MilestoneRpcLike {
  getLatestLedger(): Promise<{ sequence: number }>;
  getContractData(
    contractId: string,
    key: StellarSdk.xdr.ScVal,
  ): Promise<unknown>;
}

export interface OnChainMilestoneRead {
  milestones: MilestoneState[];
  /** Ledger sequence the milestone data was read at. */
  ledger: number;
}

/** Reader interface the scanner depends on (injectable for tests). */
export interface MilestoneChainReader {
  getLatestLedger(): Promise<number>;
  readMilestones(contractId: string): Promise<OnChainMilestoneRead>;
}

/**
 * Production implementation backed by the Soroban RPC service.
 *
 * @param rpc - RPC adapter; defaults to a wrapper around `SorobanRpcService`.
 * @param keyName - Contract data key holding milestone state (defaults to
 *                  {@link MILESTONES_CONTRACT_DATA_KEY}).
 */
export class SorobanMilestoneChainReader implements MilestoneChainReader {
  private readonly rpc: MilestoneRpcLike;
  private readonly key: StellarSdk.xdr.ScVal;

  constructor(
    rpc: MilestoneRpcLike = defaultMilestoneRpc(),
    keyName: string = MILESTONES_CONTRACT_DATA_KEY,
  ) {
    this.rpc = rpc;
    this.key = StellarSdk.nativeToScVal(keyName, { type: 'symbol' });
  }

  async getLatestLedger(): Promise<number> {
    try {
      const response = await this.rpc.getLatestLedger();
      return response.sequence;
    } catch (error) {
      throw classifySorobanRpcError(error);
    }
  }

  async readMilestones(contractId: string): Promise<OnChainMilestoneRead> {
    let ledger: number;
    try {
      ledger = await this.getLatestLedger();
    } catch (error) {
      throw classifySorobanRpcError(error);
    }

    let entry: unknown;
    try {
      entry = await this.rpc.getContractData(contractId, this.key);
    } catch (error) {
      throw classifySorobanRpcError(error);
    }

    const milestones = entry ? decodeMilestoneEntry(entry) : [];
    return { milestones, ledger };
  }
}

/**
 * Decodes a ledger entry into normalized milestone state.
 *
 * @param entry - The `LedgerEntryResult` returned by `getContractData`.
 * @returns Normalized milestones; returns `[]` when the entry has no value
 *          or the value cannot be decoded (defensive: an unreadable entry
 *          must not crash the whole scan — it is surfaced as a divergence
 *          with an explicit difference instead).
 */
export function decodeMilestoneEntry(entry: unknown): MilestoneState[] {
  try {
    const val = (entry as { val?: unknown })?.val;
    if (val === undefined) return [];
    const native = StellarSdk.scValToNative(val as StellarSdk.xdr.ScVal);
    if (!Array.isArray(native)) return [];
    return native
      .map((raw) => normalizeMilestoneState(raw as Record<string, unknown>))
      .filter((m): m is MilestoneState => m !== null);
  } catch {
    return [];
  }
}

/**
 * Normalizes a raw decoded milestone record into {@link MilestoneState}.
 *
 * Returns `null` for records missing a stable `milestone_id`, so a malformed
 * on-chain record is excluded from comparison rather than poisoning the diff.
 */
export function normalizeMilestoneState(
  raw: Record<string, unknown>,
): MilestoneState | null {
  const milestoneId = raw['milestone_id'];
  if (typeof milestoneId !== 'string' || milestoneId.length === 0) {
    return null;
  }

  const amount = toAmount(raw['amount']);
  const completed =
    raw['completed'] === true || raw['completed'] === 1 ||
    raw['completed'] === 'true';
  const deadline = toOptionalIsoString(raw['deadline']);

  return {
    milestoneId,
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    description:
      typeof raw['description'] === 'string' ? raw['description'] : '',
    amount: amount ?? 0,
    ...(deadline !== undefined && { deadline }),
    completed,
  };
}

/**
 * Coerces an amount into stroops. On-chain u128/i128 values decode to BigInt
 * via `scValToNative`; strings (abi-encoded) and plain numbers also occur.
 * Returns `undefined` for anything non-numeric so the caller's default is used.
 */
function toAmount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toOptionalIsoString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : value;
}

/** Default RPC adapter wrapping the production Soroban RPC service. */
function defaultMilestoneRpc(): MilestoneRpcLike {
  return new SorobanRpcService();
}
