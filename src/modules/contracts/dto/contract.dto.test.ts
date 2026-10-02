import { updateContractSchema } from './contract.dto';
import {
  MAX_CONTRACT_AMOUNT_STROOPS,
  MAX_CONTRACT_TERMS_LENGTH,
} from '../../../contracts/bounds';

const bodySchema = updateContractSchema.shape.body;

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

function parse(body: unknown) {
  return bodySchema.safeParse(body);
}

describe('updateContractSchema', () => {
  describe('unknown fields', () => {
    it('rejects an unrecognized top-level field', () => {
      const result = parse({ version: 0, notAField: 'nope' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].code).toBe('unrecognized_keys');
      }
    });

    it('rejects an unrecognized field nested inside a milestone', () => {
      const result = parse({
        version: 0,
        milestones: [
          { title: 'M1', description: 'desc', amount: 10, extra: 'nope' },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
      }
    });

    it('accepts a body containing only recognized fields', () => {
      const result = parse({ version: 0, title: 'Valid Title Here' });
      expect(result.success).toBe(true);
    });
  });

  describe('missing required fields', () => {
    it('rejects a body missing version', () => {
      const result = parse({ title: 'Valid Title Here' });
      expect(result.success).toBe(false);
    });
  });

  describe('wrong types', () => {
    it('rejects a non-string title', () => {
      const result = parse({ version: 0, title: 12345 });
      expect(result.success).toBe(false);
    });

    it('rejects a non-numeric budget', () => {
      const result = parse({ version: 0, budget: '1000' });
      expect(result.success).toBe(false);
    });

    it('rejects a non-boolean milestone.completed', () => {
      const result = parse({
        version: 0,
        milestones: [{ title: 'M1', description: 'desc', amount: 10, completed: 'yes' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects an invalid status enum value', () => {
      const result = parse({ version: 0, status: 'not_a_status' });
      expect(result.success).toBe(false);
    });
  });

  describe('oversized strings', () => {
    it('rejects a title over the max length', () => {
      const result = parse({ version: 0, title: 'a'.repeat(101) });
      expect(result.success).toBe(false);
    });

    it('rejects a description over the max length', () => {
      const result = parse({ version: 0, description: 'a'.repeat(1001) });
      expect(result.success).toBe(false);
    });

    it('rejects terms over the max length', () => {
      const result = parse({ version: 0, terms: 'a'.repeat(MAX_CONTRACT_TERMS_LENGTH + 1) });
      expect(result.success).toBe(false);
    });

    it('accepts terms at exactly the max length', () => {
      const result = parse({ version: 0, terms: 'a'.repeat(MAX_CONTRACT_TERMS_LENGTH) });
      expect(result.success).toBe(true);
    });
  });

  describe('boundary numbers', () => {
    it('rejects a negative version', () => {
      const result = parse({ version: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects a non-integer version', () => {
      const result = parse({ version: 1.5 });
      expect(result.success).toBe(false);
    });

    it('accepts version 0', () => {
      const result = parse({ version: 0 });
      expect(result.success).toBe(true);
    });

    it('rejects a budget of 0 (not positive)', () => {
      const result = parse({ version: 0, budget: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects a budget above the maximum contract amount', () => {
      const result = parse({ version: 0, budget: MAX_CONTRACT_AMOUNT_STROOPS + 1 });
      expect(result.success).toBe(false);
    });

    it('accepts a budget at exactly the maximum contract amount', () => {
      const result = parse({ version: 0, budget: MAX_CONTRACT_AMOUNT_STROOPS });
      expect(result.success).toBe(true);
    });

    it('rejects a milestone amount above the maximum contract amount', () => {
      const result = parse({
        version: 0,
        milestones: [
          {
            title: 'M1',
            description: 'desc',
            amount: MAX_CONTRACT_AMOUNT_STROOPS + 1,
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    // Milestone *count* is intentionally not bounded at the schema level —
    // see the comment on updateContractSchema. That limit is covered by the
    // service-layer contract_bounds_error (422) tests instead.
    it('accepts a milestones array with no schema-level count ceiling', () => {
      const milestones = Array.from({ length: 25 }, (_, i) => ({
        title: `M${i}`,
        description: 'desc',
        amount: 10,
      }));

      const result = parse({ version: 0, milestones });
      expect(result.success).toBe(true);
    });
  });

  describe('valid uuids', () => {
    it('rejects a malformed clientId', () => {
      const result = parse({ version: 0, clientId: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });

    it('accepts a well-formed clientId', () => {
      const result = parse({ version: 0, clientId: VALID_UUID });
      expect(result.success).toBe(true);
    });
  });

  describe('status transitions used for disputes', () => {
    it('accepts status: disputed', () => {
      const result = parse({ version: 0, status: 'disputed' });
      expect(result.success).toBe(true);
    });

    it('accepts a full dispute-resolution update within bounds', () => {
      const result = parse({
        version: 3,
        status: 'active',
        terms: 'Resolved after mediation.',
      });
      expect(result.success).toBe(true);
    });
  });
});
