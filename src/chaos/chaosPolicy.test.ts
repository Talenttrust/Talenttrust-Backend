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
});
