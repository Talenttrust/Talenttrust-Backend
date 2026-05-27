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

  it('uses random mode probability', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.2);
    const policy = new ChaosPolicy({
      chaosMode: 'random',
      chaosTargets: ['contracts'],
      chaosProbability: 0.5,
    });

    expect(policy.decide('contracts')).toBe('error');
    randomSpy.mockRestore();
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
  });

  describe('probability logic in random mode', () => {
    it('always returns error when probability is 1', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.9999);
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: ['contracts'],
        chaosProbability: 1,
      });

      expect(policy.decide('contracts')).toBe('error');
      jest.restoreAllMocks();
    });

    it('always returns none when probability is 0', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: ['contracts'],
        chaosProbability: 0,
      });

      expect(policy.decide('contracts')).toBe('none');
      jest.restoreAllMocks();
    });

    it('returns none when Math.random equals chaosProbability (strict less-than boundary)', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: ['contracts'],
        chaosProbability: 0.5,
      });

      expect(policy.decide('contracts')).toBe('none');
      jest.restoreAllMocks();
    });

    it('returns error when Math.random is just below chaosProbability', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.4999);
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: ['contracts'],
        chaosProbability: 0.5,
      });

      expect(policy.decide('contracts')).toBe('error');
      jest.restoreAllMocks();
    });

    it('returns none when Math.random is above chaosProbability', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.8);
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: ['contracts'],
        chaosProbability: 0.5,
      });

      expect(policy.decide('contracts')).toBe('none');
      jest.restoreAllMocks();
    });

    it('returns none for a non-targeted dependency regardless of probability', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: ['contracts'],
        chaosProbability: 1,
      });

      expect(policy.decide('payments')).toBe('none');
      jest.restoreAllMocks();
    });

    it('targets all dependencies in random mode when chaosTargets is empty', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      const policy = new ChaosPolicy({
        chaosMode: 'random',
        chaosTargets: [],
        chaosProbability: 0.5,
      });

      expect(policy.decide('contracts')).toBe('error');
      expect(policy.decide('payments')).toBe('error');
      jest.restoreAllMocks();
    });
  });
});
