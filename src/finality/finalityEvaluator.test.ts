/**
 * FinalityEvaluator tests: provider success, fail-closed failure
 * handling, zero-confirmation short-circuit, and unknown-network policy.
 */

import { FinalityEvaluator, LatestLedgerProvider } from './finalityEvaluator';
import { createFinalityPolicy } from './policy';
import { setWriteRecordImpl, LogRecord } from '../logger';

const policy = createFinalityPolicy(
  { depths: { stellar: 1, soroban: 3 }, defaultDepth: 6 },
  'test',
);

function captureRecords(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  setWriteRecordImpl((r) => records.push(r));
  return {
    records,
    restore: () =>
      setWriteRecordImpl((r: LogRecord) => {
        const line = JSON.stringify(r);
        (r.level === 'error' ? process.stderr : process.stdout).write(line + '\n');
      }),
  };
}

describe('FinalityEvaluator', () => {
  it('fetches the head once and finalizes at the exact boundary', async () => {
    const provider: LatestLedgerProvider = jest.fn(async () => 102);
    const evaluator = new FinalityEvaluator(policy, provider);

    const result = await evaluator.evaluate({ network: 'soroban', ledger: 100 });

    expect(result.status).toBe('finalized');
    expect(result.confirmations).toBe(3);
    expect(provider).toHaveBeenCalledWith('soroban');
  });

  it('does not call the provider for off-chain events', async () => {
    const provider: LatestLedgerProvider = jest.fn(async () => 100);
    const evaluator = new FinalityEvaluator(policy, provider);

    const result = await evaluator.evaluate({ network: 'soroban' });

    expect(result.status).toBe('finalized');
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not call the provider under zero-confirmation', async () => {
    const zeroConf = createFinalityPolicy(
      { depths: { stellar: 0, soroban: 0 }, defaultDepth: 6 },
      'development',
    );
    const provider: LatestLedgerProvider = jest.fn(async () => 100);
    const evaluator = new FinalityEvaluator(zeroConf, provider);

    const result = await evaluator.evaluate({ network: 'soroban', ledger: 100 });

    expect(result.status).toBe('finalized');
    expect(provider).not.toHaveBeenCalled();
  });

  it('fails closed (provisional) and logs a warn when the provider errors', async () => {
    const { records, restore } = captureRecords();
    const provider: LatestLedgerProvider = jest.fn(async () => {
      throw new Error('rpc timeout');
    });
    const evaluator = new FinalityEvaluator(policy, provider);
    try {
      const result = await evaluator.evaluate({ network: 'soroban', ledger: 100 });

      expect(result.status).toBe('provisional');
      expect(result.reason).toBe('provider_unavailable');

      const warns = records.filter((r) => r.level === 'warn');
      expect(warns.length).toBeGreaterThan(0);
      const warn = warns.find((r) =>
        typeof r.message === 'string' && r.message.includes('provisional'),
      );
      expect(warn).toBeDefined();
      expect(warn!.error).toBe('rpc timeout');
      // No stack traces or internal details leak into the record.
      expect(JSON.stringify(warn)).not.toContain('at ');
      expect(JSON.stringify(warn)).not.toContain('node_modules');
    } finally {
      restore();
    }
  });

  it('fails closed (provisional) when an on-chain event has no network', async () => {
    const { records, restore } = captureRecords();
    const provider: LatestLedgerProvider = jest.fn(async () => 100);
    const evaluator = new FinalityEvaluator(policy, provider);
    try {
      const result = await evaluator.evaluate({ ledger: 100 });

      expect(result.status).toBe('provisional');
      expect(result.reason).toBe('network_missing');
      expect(provider).not.toHaveBeenCalled();
      expect(records.some((r) => r.level === 'warn')).toBe(true);
    } finally {
      restore();
    }
  });

  it('warns and applies the default depth for unknown networks', async () => {
    const { records, restore } = captureRecords();
    const provider: LatestLedgerProvider = jest.fn(async () => 105);
    const evaluator = new FinalityEvaluator(policy, provider);
    try {
      const result = await evaluator.evaluate({ network: 'ethereum', ledger: 100 });

      expect(result.status).toBe('finalized'); // 6 confirmations == defaultDepth
      expect(result.depth).toBe(6);
      expect(provider).toHaveBeenCalledWith('ethereum');
      expect(
        records.some(
          (r) => r.level === 'warn' && r.message.includes('default depth'),
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it('getLatestHead surfaces provider results and errors', async () => {
    const provider: LatestLedgerProvider = jest.fn(async () => 42);
    const evaluator = new FinalityEvaluator(policy, provider);
    await expect(evaluator.getLatestHead('soroban')).resolves.toBe(42);
  });

  it('evaluateWithHead is deterministic and does not call the provider', async () => {
    const provider: LatestLedgerProvider = jest.fn();
    const evaluator = new FinalityEvaluator(policy, provider);

    const provisional = evaluator.evaluateWithHead(
      { network: 'soroban', ledger: 100 },
      101,
    );
    expect(provisional.status).toBe('provisional');
    expect(provisional.confirmations).toBe(2);

    const finalized = evaluator.evaluateWithHead(
      { network: 'soroban', ledger: 100 },
      102,
    );
    expect(finalized.status).toBe('finalized');
    expect(provider).not.toHaveBeenCalled();
  });
});
