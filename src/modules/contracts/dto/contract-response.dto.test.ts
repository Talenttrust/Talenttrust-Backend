import { ResponseContractError } from '../../../errors/appError';
import {
  assertResponseSchema,
  contractBoundsResponseSchema,
  contractListResponseSchema,
  contractResponseSchema,
  contractStatsResponseSchema,
  deleteContractResponseSchema,
} from './contract-response.dto';

const VALID_CONTRACT = {
  id: 'contract-1',
  title: 'Build a typed boundary',
  clientId: 'client-1',
  freelancerId: 'freelancer-1',
  amount: 2_000,
  status: 'active',
  createdAt: '2026-07-25T10:00:00.000Z',
  version: 3,
};

describe('contractResponseSchema', () => {
  it('accepts a fully-populated valid contract', () => {
    expect(contractResponseSchema.safeParse(VALID_CONTRACT).success).toBe(true);
  });

  it.each(['id', 'title', 'clientId', 'freelancerId', 'amount', 'status', 'createdAt', 'version'])(
    'rejects a contract missing %s',
    (field) => {
      const { [field]: _omitted, ...rest } = VALID_CONTRACT as Record<string, unknown>;
      expect(contractResponseSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('rejects an invalid status enum value', () => {
    const result = contractResponseSchema.safeParse({ ...VALID_CONTRACT, status: 'PENDING' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric amount', () => {
    const result = contractResponseSchema.safeParse({ ...VALID_CONTRACT, amount: '2000' });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized extra field', () => {
    const result = contractResponseSchema.safeParse({ ...VALID_CONTRACT, extra: 'nope' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
    }
  });
});

describe('contractListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(contractListResponseSchema.safeParse([]).success).toBe(true);
  });

  it('accepts a list of valid contracts', () => {
    expect(
      contractListResponseSchema.safeParse([VALID_CONTRACT, { ...VALID_CONTRACT, id: 'contract-2' }]).success,
    ).toBe(true);
  });

  it('rejects a list containing one invalid contract', () => {
    const result = contractListResponseSchema.safeParse([VALID_CONTRACT, { id: 'only-id' }]);
    expect(result.success).toBe(false);
  });
});

describe('contractStatsResponseSchema', () => {
  const VALID_STATS = { total: 5, totalBudget: 12_000, byStatus: { active: 3, draft: 2 } };

  it('accepts valid stats', () => {
    expect(contractStatsResponseSchema.safeParse(VALID_STATS).success).toBe(true);
  });

  it('accepts an empty byStatus map', () => {
    expect(
      contractStatsResponseSchema.safeParse({ total: 0, totalBudget: 0, byStatus: {} }).success,
    ).toBe(true);
  });

  it('rejects a negative total', () => {
    expect(
      contractStatsResponseSchema.safeParse({ ...VALID_STATS, total: -1 }).success,
    ).toBe(false);
  });

  it('rejects a non-numeric byStatus count', () => {
    const result = contractStatsResponseSchema.safeParse({
      ...VALID_STATS,
      byStatus: { active: 'three' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized extra field', () => {
    expect(
      contractStatsResponseSchema.safeParse({ ...VALID_STATS, extra: 1 }).success,
    ).toBe(false);
  });
});

describe('contractBoundsResponseSchema', () => {
  it('accepts valid bounds', () => {
    expect(
      contractBoundsResponseSchema.safeParse({
        maxMilestonesPerContract: 20,
        maxContractAmountStroops: 100_000_000_000_000,
      }).success,
    ).toBe(true);
  });

  it('rejects a zero or negative bound', () => {
    expect(
      contractBoundsResponseSchema.safeParse({
        maxMilestonesPerContract: 0,
        maxContractAmountStroops: 100,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(
      contractBoundsResponseSchema.safeParse({ maxMilestonesPerContract: 20 }).success,
    ).toBe(false);
  });
});

describe('deleteContractResponseSchema', () => {
  it('accepts a valid delete confirmation message', () => {
    expect(
      deleteContractResponseSchema.safeParse({ message: 'Contract deleted successfully' }).success,
    ).toBe(true);
  });

  it('rejects a non-string message', () => {
    expect(deleteContractResponseSchema.safeParse({ message: 123 }).success).toBe(false);
  });

  it('rejects a missing message', () => {
    expect(deleteContractResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('assertResponseSchema', () => {
  it('returns the parsed data when it matches the schema', () => {
    const result = assertResponseSchema(contractResponseSchema, VALID_CONTRACT, 'Contract');
    expect(result).toEqual(VALID_CONTRACT);
  });

  it('throws a ResponseContractError when data fails the schema', () => {
    expect(() =>
      assertResponseSchema(contractResponseSchema, { id: 'only-id' }, 'Contract'),
    ).toThrow(ResponseContractError);
  });

  it('includes the context label and field detail in the thrown error message', () => {
    try {
      assertResponseSchema(contractResponseSchema, { id: 'only-id' }, 'Contract');
      throw new Error('expected assertResponseSchema to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseContractError);
      expect((error as ResponseContractError).message).toContain('Contract response failed schema validation');
    }
  });

  it('never exposes the raw validation detail to API clients (expose: false)', () => {
    let caught: ResponseContractError | undefined;
    try {
      assertResponseSchema(contractResponseSchema, { id: 'only-id' }, 'Contract');
    } catch (error) {
      caught = error as ResponseContractError;
    }
    expect(caught?.expose).toBe(false);
    expect(caught?.statusCode).toBe(500);
    expect(caught?.code).toBe('response_contract_error');
  });
});
