import { ChaosPolicy } from './chaosPolicy';

describe('ChaosPolicy', () => {
  it('returns none when mode is off', () => {
    const policy = new ChaosPolicy({
      chaosMode: 'off',
      chaosTargets: ['contracts'],
      chaosProbability: 1,
    });

    expect(policy.decide('contracts')).toBe('none');
  });

  it('returns error only for targeted dependency', () => {
    const policy = new ChaosPolicy({
      chaosMode: 'error',
      chaosTargets: ['contracts'],
      chaosProbability: 1,
    });

    expect(policy.decide('contracts')).toBe('error');
    expect(policy.decide('payments')).toBe('none');
  });

  describe('target matching', () => {
    it('targets all dependencies when chaosTargets is empty', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'error',
        chaosTargets: [],
        chaosProbability: 1,
      });

      expect(policy.decide('contracts')).toBe('error');
      expect(policy.decide('payments')).toBe('error');
      expect(policy.decide('database')).toBe('error');
    });

    it('matches dependency names case-insensitively', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'error',
        chaosTargets: ['contracts'],
        chaosProbability: 1,
      });

      expect(policy.decide('Contracts')).toBe('error');
      expect(policy.decide('CONTRACTS')).toBe('error');
      expect(policy.decide('ConTrAcTs')).toBe('error');
    });

    it('returns none for a dependency not in the target list', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'error',
        chaosTargets: ['contracts', 'database'],
        chaosProbability: 1,
      });

      expect(policy.decide('payments')).toBe('none');
    });

    it('matches any entry in a multi-target list', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'error',
        chaosTargets: ['contracts', 'database', 'cache'],
        chaosProbability: 1,
      });

      expect(policy.decide('contracts')).toBe('error');
      expect(policy.decide('database')).toBe('error');
      expect(policy.decide('cache')).toBe('error');
    });

    it('returns none for dependencies outside a multi-target list', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'error',
        chaosTargets: ['contracts', 'database'],
        chaosProbability: 1,
      });

      expect(policy.decide('payments')).toBe('none');
      expect(policy.decide('cache')).toBe('none');
    });
  });

  describe('mode behavior', () => {
    it('returns timeout for a targeted dependency in timeout mode', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'timeout',
        chaosTargets: ['contracts'],
        chaosProbability: 1,
      });

      expect(policy.decide('contracts')).toBe('timeout');
    });

    it('returns none for a non-targeted dependency in timeout mode', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'timeout',
        chaosTargets: ['contracts'],
        chaosProbability: 1,
      });

      expect(policy.decide('payments')).toBe('none');
    });

    it('returns none for off mode even when targets is empty (wildcard)', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'off',
        chaosTargets: [],
        chaosProbability: 1,
      });

      expect(policy.decide('contracts')).toBe('none');
    });

    it('returns none for an unknown mode, falling back to default', () => {
      const policy = new ChaosPolicy({
        chaosMode: 'invalid_mode' as any,
        chaosTargets: ['contracts'],
        chaosProbability: 1,
      });

      expect(policy.decide('contracts')).toBe('none');
    });
  });

  describe('probability logic in random mode', () => {
    it('always returns error when probability is 1', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 1,
        },
        () => 0.9999,
      );

      expect(policy.decide('contracts')).toBe('error');
    });

    it('always returns none when probability is 0', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 0,
        },
        () => 0.5,
      );

      expect(policy.decide('contracts')).toBe('none');
    });

    it('always returns none when probability is negative', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: -0.1,
        },
        () => 0.5,
      );

      expect(policy.decide('contracts')).toBe('none');
    });

    it('always returns error when probability is greater than 1', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 1.5,
        },
        () => 0.5,
      );

      expect(policy.decide('contracts')).toBe('error');
    });

    it('returns none when random equals chaosProbability (strict less-than boundary)', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 0.5,
        },
        () => 0.5,
      );

      expect(policy.decide('contracts')).toBe('none');
    });

    it('returns error when random is just below chaosProbability', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 0.5,
        },
        () => 0.4999,
      );

      expect(policy.decide('contracts')).toBe('error');
    });

    it('returns none when random is above chaosProbability', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 0.5,
        },
        () => 0.8,
      );

      expect(policy.decide('contracts')).toBe('none');
    });

    it('returns none for a non-targeted dependency regardless of probability', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 1,
        },
        () => 0.5,
      );

      expect(policy.decide('payments')).toBe('none');
    });

    it('targets all dependencies in random mode when chaosTargets is empty', () => {
      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: [],
          chaosProbability: 0.5,
        },
        () => 0.1,
      );

      expect(policy.decide('contracts')).toBe('error');
      expect(policy.decide('payments')).toBe('error');
    });

    it('uses injected random function for deterministic decision sequences', () => {
      // Deterministic sequence: first call returns error, second returns none
      const rngSequence = jest
        .fn()
        .mockReturnValueOnce(0.2)
        .mockReturnValueOnce(0.8);

      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 0.5,
        },
        rngSequence,
      );

      expect(policy.decide('contracts')).toBe('error');
      expect(policy.decide('contracts')).toBe('none');
      expect(rngSequence).toHaveBeenCalledTimes(2);
    });

    it('produces reproducible exact decision sequences with seeded RNG', () => {
      // Simulate a seeded RNG that returns specific values in sequence
      const seededValues = [0, 0.25, 0.5, 0.75, 1];
      let callIndex = 0;
      const seededRng = () => seededValues[callIndex++] as number;

      const policy = new ChaosPolicy(
        {
          chaosMode: 'random',
          chaosTargets: ['contracts'],
          chaosProbability: 0.5,
        },
        seededRng,
      );

      // 0 < 0.5 → error
      expect(policy.decide('contracts')).toBe('error');
      // 0.25 < 0.5 → error
      expect(policy.decide('contracts')).toBe('error');
      // 0.5 is NOT < 0.5 → none
      expect(policy.decide('contracts')).toBe('none');
      // 0.75 >= 0.5 → none
      expect(policy.decide('contracts')).toBe('none');
      // 1 >= 0.5 → none
      expect(policy.decide('contracts')).toBe('none');
    });
  });

  describe('default random behavior (production)', () => {
    it('uses Math.random by default in production', () => {
      // Verify the injected function defaults correctly without mocking Math.random
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: ['contracts'],
        chaosProbability: 0.5,
      });

      // Call multiple times - not testing exact values, just that it uses the default
      const results = [0, 0, 0].map(() => policy.decide('contracts'));
      const hasValidResults = results.every(
        (r) => r === 'error' || r === 'none',
      );
      expect(hasValidResults).toBe(true);
    });
  });
});
