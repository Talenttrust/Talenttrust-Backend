/**
 * Milestone chain reader tests.
 *
 * Covers on-chain decoding (BigInt amounts, missing fields, unreadable
 * entries) and the reader's failure contract: RPC errors are classified
 * (never raw-thrown) so the scanner can turn them into `unavailable` reports.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import {
  SorobanMilestoneChainReader,
  decodeMilestoneEntry,
  normalizeMilestoneState,
  type MilestoneRpcLike,
} from './chain-reader';
import { SorobanRpcTimeoutError } from '../../errors/appError';

/** Builds a ledger-entry-shaped object with a real ScVal value. */
function entryWith(native: unknown): { val: StellarSdk.xdr.ScVal } {
  return { val: StellarSdk.nativeToScVal(native) };
}

describe('decodeMilestoneEntry', () => {
  it('decodes an array of milestone records', () => {
    const milestones = decodeMilestoneEntry(
      entryWith([
        {
          milestone_id: 'm1',
          title: 'Design',
          description: 'Review',
          amount: 500,
          deadline: null,
          completed: true,
        },
      ]),
    );
    expect(milestones).toEqual([
      {
        milestoneId: 'm1',
        title: 'Design',
        description: 'Review',
        amount: 500,
        completed: true,
      },
    ]);
  });

  it('coerces BigInt amounts (u128 decode) into numbers', () => {
    const milestones = decodeMilestoneEntry(
      entryWith([{ milestone_id: 'm1', title: 'T', amount: 900, completed: false }]),
    );
    expect(milestones[0]!.amount).toBe(900);
  });

  it('preserves a string deadline when present', () => {
    const milestones = decodeMilestoneEntry(
      entryWith([
        { milestone_id: 'm1', title: 'T', amount: 1, deadline: '2026-12-31T00:00:00.000Z', completed: false },
      ]),
    );
    expect(milestones[0]!.deadline).toBe('2026-12-31T00:00:00.000Z');
  });

  it('returns [] for an entry with no value', () => {
    expect(decodeMilestoneEntry({})).toEqual([]);
    expect(decodeMilestoneEntry(undefined)).toEqual([]);
  });

  it('returns [] for a value that is not an array (defensive)', () => {
    expect(decodeMilestoneEntry(entryWith({ not: 'an array' }))).toEqual([]);
  });

  it('drops records without a stable milestone_id', () => {
    const milestones = decodeMilestoneEntry(
      entryWith([
        { title: 'No id', amount: 1, completed: false },
        { milestone_id: 'm2', title: 'Ok', amount: 2, completed: false },
      ]),
    );
    expect(milestones.map((m) => m.milestoneId)).toEqual(['m2']);
  });

  it('never throws on garbage input', () => {
    expect(() => decodeMilestoneEntry('garbage')).not.toThrow();
    expect(() => decodeMilestoneEntry(null)).not.toThrow();
    expect(decodeMilestoneEntry('garbage')).toEqual([]);
  });
});

describe('normalizeMilestoneState', () => {
  it('fills defaults for missing fields', () => {
    const state = normalizeMilestoneState({ milestone_id: 'm1', amount: 5 });
    expect(state).toEqual({
      milestoneId: 'm1',
      title: '',
      description: '',
      amount: 5,
      completed: false,
    });
  });

  it('returns null without a milestone_id', () => {
    expect(normalizeMilestoneState({ title: 'x' })).toBeNull();
  });
});

describe('SorobanMilestoneChainReader', () => {
  const makeRpc = (overrides: Partial<MilestoneRpcLike> = {}): MilestoneRpcLike => ({
    getLatestLedger: async () => ({ sequence: 500 }),
    getContractData: async () => entryWith([
      { milestone_id: 'm1', title: 'T', amount: 10, completed: true },
    ]),
    ...overrides,
  });

  it('reads milestones with the latest ledger as block height', async () => {
    const reader = new SorobanMilestoneChainReader(makeRpc());
    const read = await reader.readMilestones('contract-1');
    expect(read.ledger).toBe(500);
    expect(read.milestones[0]!.milestoneId).toBe('m1');
  });

  it('returns an empty milestone list when the contract has no milestone data', async () => {
    const rpc = makeRpc({ getContractData: async () => undefined });
    const reader = new SorobanMilestoneChainReader(rpc);
    const read = await reader.readMilestones('contract-empty');
    expect(read.milestones).toEqual([]);
    expect(read.ledger).toBe(500);
  });

  it('classifies head-ledger failures instead of leaking raw errors', async () => {
    const rpc = makeRpc({
      getLatestLedger: async () => {
        const err = new Error('fetch failed') as Error & { name: string };
        err.name = 'AbortError';
        throw err;
      },
    });
    const reader = new SorobanMilestoneChainReader(rpc);
    await expect(reader.getLatestLedger()).rejects.toBeInstanceOf(
      SorobanRpcTimeoutError,
    );
  });

  it('classifies per-contract data failures (missing contract → not found)', async () => {
    const rpc = makeRpc({
      getContractData: async () => {
        const err = new Error('missing entry') as Error & {
          code?: string;
          error?: { code?: string };
        };
        err.code = '-32601';
        throw err;
      },
    });
    const reader = new SorobanMilestoneChainReader(rpc);
    await expect(reader.readMilestones('contract-x')).rejects.toThrow();
  });
});
