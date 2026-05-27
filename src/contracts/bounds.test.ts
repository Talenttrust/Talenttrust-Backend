import {
  validateContractBounds,
  MAX_MILESTONES_PER_CONTRACT,
  MAX_CONTRACT_AMOUNT_STROOPS,
  CONTRACT_BOUNDS,
  ContractBoundsError,
  Milestone,
} from './bounds';

describe('CONTRACT_BOUNDS', () => {
  it('exports maxMilestonesPerContract matching the constant', () => {
    expect(CONTRACT_BOUNDS.maxMilestonesPerContract).toBe(MAX_MILESTONES_PER_CONTRACT);
  });

  it('exports maxContractAmountStroops matching the constant', () => {
    expect(CONTRACT_BOUNDS.maxContractAmountStroops).toBe(MAX_CONTRACT_AMOUNT_STROOPS);
  });
});

describe('ContractBoundsError', () => {
  it('has name ContractBoundsError', () => {
    const e = new ContractBoundsError('test');
    expect(e.name).toBe('ContractBoundsError');
    expect(e.message).toBe('test');
    expect(e instanceof Error).toBe(true);
  });
});

describe('validateContractBounds', () => {
  describe('budget cap', () => {
    it('accepts budget exactly at the cap', () => {
      const result = validateContractBounds(MAX_CONTRACT_AMOUNT_STROOPS);
      expect(result.valid).toBe(true);
    });

    it('rejects budget one stroop above the cap', () => {
      const result = validateContractBounds(MAX_CONTRACT_AMOUNT_STROOPS + 1);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/Budget exceeds/);
    });

    it('accepts budget of 1', () => {
      expect(validateContractBounds(1).valid).toBe(true);
    });
  });

  describe('milestone count cap', () => {
    const makeMilestones = (count: number): Milestone[] =>
      Array.from({ length: count }, (_, i) => ({ title: `M${i}`, amount: 1 }));

    it('accepts exactly MAX_MILESTONES_PER_CONTRACT milestones', () => {
      const result = validateContractBounds(1000, makeMilestones(MAX_MILESTONES_PER_CONTRACT));
      expect(result.valid).toBe(true);
    });

    it('rejects MAX_MILESTONES_PER_CONTRACT + 1 milestones', () => {
      const result = validateContractBounds(1000, makeMilestones(MAX_MILESTONES_PER_CONTRACT + 1));
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/Milestone count/);
    });

    it('accepts zero milestones', () => {
      expect(validateContractBounds(1000, []).valid).toBe(true);
    });

    it('is valid when milestones are undefined', () => {
      expect(validateContractBounds(1000, undefined).valid).toBe(true);
    });
  });

  describe('total milestone amount cap', () => {
    it('accepts total exactly at the cap', () => {
      const half = MAX_CONTRACT_AMOUNT_STROOPS / 2;
      const milestones: Milestone[] = [
        { title: 'A', amount: half },
        { title: 'B', amount: half },
      ];
      expect(validateContractBounds(1000, milestones).valid).toBe(true);
    });

    it('rejects total one stroop above the cap', () => {
      const milestones: Milestone[] = [
        { title: 'A', amount: MAX_CONTRACT_AMOUNT_STROOPS },
        { title: 'B', amount: 1 },
      ];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/Total milestone amount/);
    });

    it('rejects when a single milestone amount causes overflow', () => {
      const milestones: Milestone[] = [
        { title: 'A', amount: Number.MAX_VALUE },
        { title: 'B', amount: Number.MAX_VALUE },
      ];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
    });

    it('stops accumulating at first breach and rejects', () => {
      const milestones: Milestone[] = [
        { title: 'A', amount: MAX_CONTRACT_AMOUNT_STROOPS },
        { title: 'B', amount: MAX_CONTRACT_AMOUNT_STROOPS },
      ];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/Total milestone amount/);
    });
  });

  describe('combined checks', () => {
    it('budget cap is checked before milestone count', () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, () => ({
        title: 'x',
        amount: 1,
      }));
      const result = validateContractBounds(MAX_CONTRACT_AMOUNT_STROOPS + 1, milestones);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/Budget exceeds/);
    });
  });
});
