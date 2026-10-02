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

    it('accepts budget of 0', () => {
      expect(validateContractBounds(0).valid).toBe(true);
    });

    it('accepts negative budget', () => {
      expect(validateContractBounds(-1).valid).toBe(true);
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

    it('accepts milestone with zero amount', () => {
      const milestones: Milestone[] = [{ title: 'Zero', amount: 0 }];
      expect(validateContractBounds(1000, milestones).valid).toBe(true);
    });

    it('accepts milestone with negative amount', () => {
      const milestones: Milestone[] = [{ title: 'Neg', amount: -1 }];
      expect(validateContractBounds(1000, milestones).valid).toBe(true);
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

  // ──────────────────────────────────────────────────────────────────────────
  // Regression tests — issue #923
  //
  // These lock in fixes for cases that were previously either uncaught
  // exceptions (crashed instead of returning a validation result) or
  // silently accepted malformed input as valid. validateContractBounds is
  // the function whose entire job is defending against malformed input, so
  // it must not depend on an upstream caller (e.g. the DTO/Zod layer) having
  // already validated types first — a future internal caller that bypasses
  // that layer (bulk import, admin override, migration script) must still
  // get a graceful validation error, not a crash or a false "valid".
  // ──────────────────────────────────────────────────────────────────────────
  describe('regression: malformed budget (issue #923)', () => {
    it('rejects NaN budget instead of silently passing (NaN > x is always false)', () => {
      const result = validateContractBounds(NaN, []);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/finite/i);
    });

    it('rejects Infinity budget', () => {
      const result = validateContractBounds(Infinity, []);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/finite/i);
    });

    it('rejects -Infinity budget', () => {
      const result = validateContractBounds(-Infinity, []);
      expect(result.valid).toBe(false);
    });

    it('rejects undefined budget at runtime (bypassing the TS type)', () => {
      const result = validateContractBounds(undefined as unknown as number, []);
      expect(result.valid).toBe(false);
    });

    it('rejects a string budget at runtime (bypassing the TS type)', () => {
      const result = validateContractBounds('1000' as unknown as number, []);
      expect(result.valid).toBe(false);
    });

    it('rejects null budget at runtime (bypassing the TS type)', () => {
      const result = validateContractBounds(null as unknown as number, []);
      expect(result.valid).toBe(false);
    });
  });

  describe('regression: malformed milestones array (issue #923)', () => {
    it('treats null milestones the same as undefined (valid, no milestones) instead of throwing', () => {
      // Previously: TypeError: Cannot read properties of null (reading 'length')
      const result = validateContractBounds(1000, null);
      expect(result.valid).toBe(true);
    });

    it('rejects a non-array milestones value instead of throwing on .length', () => {
      const result = validateContractBounds(1000, 'not-an-array' as unknown as Milestone[]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/array/i);
    });

    it('rejects a plain-object (non-array) milestones value', () => {
      const result = validateContractBounds(1000, { title: 'x', amount: 1 } as unknown as Milestone[]);
      expect(result.valid).toBe(false);
    });

    it('rejects an array containing a null entry instead of throwing on .amount', () => {
      // Previously: TypeError: Cannot read properties of null (reading 'amount')
      const milestones = [null, { title: 'ok', amount: 1 }] as unknown as Milestone[];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/finite numeric amount/i);
    });

    it('rejects an array containing an undefined entry', () => {
      const milestones = [{ title: 'ok', amount: 1 }, undefined] as unknown as Milestone[];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
    });

    it('rejects an array containing a primitive entry (e.g. a bare number)', () => {
      const milestones = [42] as unknown as Milestone[];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
    });

    it('rejects a milestone with a NaN amount instead of letting it corrupt the running total', () => {
      const milestones = [{ title: 'x', amount: NaN }] as unknown as Milestone[];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/finite numeric amount/i);
    });

    it('rejects a milestone with an Infinity amount', () => {
      const milestones = [{ title: 'x', amount: Infinity }];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
    });

    it('rejects a milestone with a non-numeric amount at runtime (bypassing the TS type)', () => {
      const milestones = [{ title: 'x', amount: '100' }] as unknown as Milestone[];
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(false);
    });
  });

  describe('regression: empty-input edge cases (issue #923)', () => {
    it('accepts an empty milestones array with a zero budget (fully empty contract)', () => {
      expect(validateContractBounds(0, []).valid).toBe(true);
    });

    it('is valid when both budget is 0 and milestones is undefined', () => {
      expect(validateContractBounds(0, undefined).valid).toBe(true);
    });

    it('is valid when both budget is 0 and milestones is null', () => {
      expect(validateContractBounds(0, null).valid).toBe(true);
    });
  });

  describe('regression: boundary edge cases (issue #923)', () => {
    it('accepts a single milestone whose amount exactly equals the budget', () => {
      const result = validateContractBounds(500, [{ title: 'x', amount: 500 }]);
      expect(result.valid).toBe(true);
    });

    it('rejects the smallest possible over-cap total (cap + Number.EPSILON-scale unit)', () => {
      const result = validateContractBounds(1000, [
        { title: 'x', amount: MAX_CONTRACT_AMOUNT_STROOPS },
        { title: 'y', amount: 1 },
      ]);
      expect(result.valid).toBe(false);
    });

    it('accepts MAX_MILESTONES_PER_CONTRACT milestones each with a tiny fractional amount summing under the cap', () => {
      const milestones: Milestone[] = Array.from({ length: MAX_MILESTONES_PER_CONTRACT }, (_, i) => ({
        title: `M${i}`,
        amount: 0.1,
      }));
      const result = validateContractBounds(1000, milestones);
      expect(result.valid).toBe(true);
    });
  });
});
