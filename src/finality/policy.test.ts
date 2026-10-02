/**
 * Finality policy tests.
 *
 * Required edge cases covered:
 * - zero confirmations in development
 * - exact finality boundary
 * - reorg before finality
 * - provider lag
 * - unknown network policy
 * - off-chain events, missing head (fail-closed), zero-conf disabled
 */

import {
  createFinalityPolicy,
  evaluateFinality,
  getFinalityDepth,
  NetworkFinalityPolicy,
  parseFinalityDepths,
} from './policy';

function policy(overrides: Partial<NetworkFinalityPolicy> = {}): NetworkFinalityPolicy {
  return {
    depths: { stellar: 1, soroban: 3 },
    defaultDepth: 6,
    allowZeroConfirmation: true,
    ...overrides,
  };
}

describe('parseFinalityDepths', () => {
  it('returns built-in defaults when unset', () => {
    expect(parseFinalityDepths(undefined)).toEqual({ stellar: 1, soroban: 1 });
  });

  it('parses comma-separated network=depth pairs', () => {
    expect(parseFinalityDepths('stellar=2,soroban=5')).toEqual({
      stellar: 2,
      soroban: 5,
    });
  });

  it('rejects malformed entries', () => {
    expect(() => parseFinalityDepths('stellar')).toThrow(/malformed/);
    expect(() => parseFinalityDepths('=3')).toThrow(/malformed/);
    expect(() => parseFinalityDepths('stellar=-1')).toThrow(/invalid/);
    expect(() => parseFinalityDepths('stellar=abc')).toThrow(/invalid/);
  });
});

describe('createFinalityPolicy', () => {
  it('defaults zero-confirmation to true outside production', () => {
    const p = createFinalityPolicy(
      { depths: { stellar: 0 }, defaultDepth: 6 },
      'development',
    );
    expect(p.allowZeroConfirmation).toBe(true);
    expect(p.depths.stellar).toBe(0);
  });

  it('forbids zero-confirmation in production by default', () => {
    const p = createFinalityPolicy(
      { depths: { stellar: 0 }, defaultDepth: 6 },
      'production',
    );
    expect(p.allowZeroConfirmation).toBe(false);
    expect(p.depths.stellar).toBe(1); // clamped
  });

  it('honours an explicit zero-confirmation flag', () => {
    const allowed = createFinalityPolicy(
      { depths: { stellar: 0 }, defaultDepth: 6, allowZeroConfirmation: true },
      'production',
    );
    expect(allowed.allowZeroConfirmation).toBe(true);
    expect(allowed.depths.stellar).toBe(0);

    const denied = createFinalityPolicy(
      { depths: { stellar: 0 }, defaultDepth: 6, allowZeroConfirmation: false },
      'development',
    );
    expect(denied.depths.stellar).toBe(1);
  });

  it('clamps a zero default depth when zero-confirmation is disabled', () => {
    const p = createFinalityPolicy(
      { depths: {}, defaultDepth: 0, allowZeroConfirmation: false },
      'production',
    );
    expect(p.defaultDepth).toBe(1);
  });
});

describe('getFinalityDepth', () => {
  it('resolves known networks', () => {
    expect(getFinalityDepth(policy(), 'soroban')).toEqual({ depth: 3, known: true });
  });

  it('falls back to the conservative default for unknown networks', () => {
    expect(getFinalityDepth(policy(), 'ethereum')).toEqual({ depth: 6, known: false });
    expect(getFinalityDepth(policy(), undefined)).toEqual({ depth: 6, known: false });
  });
});

describe('evaluateFinality', () => {
  describe('zero confirmations in development', () => {
    it('finalizes immediately when the network depth is 0', () => {
      const p = policy({ depths: { stellar: 0, soroban: 3 } });
      const result = evaluateFinality(p, { network: 'stellar', ledger: 100, headLedger: 99 });
      expect(result.status).toBe('finalized');
      expect(result.depth).toBe(0);
    });

    it('does not require a chain head under zero-confirmation', () => {
      const p = policy({ depths: { stellar: 0, soroban: 3 } });
      const result = evaluateFinality(p, { network: 'stellar', ledger: 100 });
      expect(result.status).toBe('finalized');
    });
  });

  describe('exact finality boundary', () => {
    const p = policy({ depths: { stellar: 1, soroban: 3 } });

    it('finalizes exactly at the boundary (confirmations === depth)', () => {
      // ledger 100, head 102 -> 3 confirmations == depth 3
      const result = evaluateFinality(p, { network: 'soroban', ledger: 100, headLedger: 102 });
      expect(result.status).toBe('finalized');
      expect(result.confirmations).toBe(3);
    });

    it('stays provisional one confirmation before the boundary', () => {
      // ledger 100, head 101 -> 2 confirmations < depth 3
      const result = evaluateFinality(p, { network: 'soroban', ledger: 100, headLedger: 101 });
      expect(result.status).toBe('provisional');
      expect(result.confirmations).toBe(2);
      expect(result.reason).toBe('pending_confirmations');
    });

    it('finalizes at depth 1 as soon as the event is on the head', () => {
      const result = evaluateFinality(p, { network: 'stellar', ledger: 100, headLedger: 100 });
      expect(result.status).toBe('finalized');
      expect(result.confirmations).toBe(1);
    });
  });

  describe('reorg before finality', () => {
    const p = policy({ depths: { stellar: 1, soroban: 3 } });

    it('reverts to provisional when the head regresses below the boundary', () => {
      // Earlier the head was 103 (would have been finalized at depth 3),
      // but a reorg moved the head back to 101: confirmations drop to 2.
      const result = evaluateFinality(p, { network: 'soroban', ledger: 100, headLedger: 101 });
      expect(result.status).toBe('provisional');
      expect(result.confirmations).toBe(2);
    });

    it('never finalizes an event whose ledger is ahead of the head after a reorg', () => {
      const result = evaluateFinality(p, { network: 'soroban', ledger: 100, headLedger: 98 });
      expect(result.status).toBe('provisional');
      expect(result.reason).toBe('provider_lag');
    });
  });

  describe('provider lag', () => {
    const p = policy();

    it('marks events provisional when the head is behind the event ledger', () => {
      const result = evaluateFinality(p, { network: 'soroban', ledger: 100, headLedger: 90 });
      expect(result.status).toBe('provisional');
      expect(result.reason).toBe('provider_lag');
    });
  });

  describe('unknown network policy', () => {
    const p = policy({ depths: { stellar: 1, soroban: 3 } });

    it('applies the conservative default depth to unknown networks', () => {
      // defaultDepth 6; ledger 100, head 105 -> 6 confirmations == depth
      const atBoundary = evaluateFinality(p, { network: 'ethereum', ledger: 100, headLedger: 105 });
      expect(atBoundary.status).toBe('finalized');
      expect(atBoundary.depth).toBe(6);

      const beforeBoundary = evaluateFinality(p, { network: 'ethereum', ledger: 100, headLedger: 104 });
      expect(beforeBoundary.status).toBe('provisional');
      expect(beforeBoundary.depth).toBe(6);
    });
  });

  describe('off-chain and missing-head handling', () => {
    it('finalizes off-chain events (no ledger) immediately', () => {
      const result = evaluateFinality(policy(), { network: 'soroban' });
      expect(result.status).toBe('finalized');
    });

    it('fails closed (provisional) when the head is unavailable', () => {
      const result = evaluateFinality(policy(), { network: 'soroban', ledger: 100 });
      expect(result.status).toBe('provisional');
      expect(result.reason).toBe('head_unavailable');
    });
  });
});
