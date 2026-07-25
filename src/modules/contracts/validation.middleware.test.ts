import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { validateUpdateContract } from './validation.middleware';
import { MissingVersionError, InvalidVersionError } from '../../errors/appError';
import {
  MAX_CONTRACT_AMOUNT_STROOPS,
  MAX_CONTRACT_TERMS_LENGTH,
} from '../../contracts/bounds';

function run(body: unknown) {
  const req = { body } as Request;
  const next = jest.fn() as unknown as NextFunction;
  validateUpdateContract(req, {} as Response, next);
  return { req, next };
}

describe('validateUpdateContract', () => {
  describe('version guard', () => {
    it('calls next with MissingVersionError when version is absent', () => {
      const { next } = run({ title: 'Valid Title Here' });
      expect(next).toHaveBeenCalledWith(expect.any(MissingVersionError));
    });

    it('calls next with InvalidVersionError when version is negative', () => {
      const { next } = run({ version: -1 });
      expect(next).toHaveBeenCalledWith(expect.any(InvalidVersionError));
    });

    it('calls next with InvalidVersionError when version is a string', () => {
      const { next } = run({ version: '0' });
      expect(next).toHaveBeenCalledWith(expect.any(InvalidVersionError));
    });

    it('reports InvalidVersionError rather than a generic ZodError when other fields are also invalid', () => {
      const { next } = run({ version: -1, title: 'x', notAField: true });
      expect(next).toHaveBeenCalledWith(expect.any(InvalidVersionError));
    });
  });

  describe('unknown fields', () => {
    it('passes a ZodError to next() for an unrecognized top-level field', () => {
      const { next } = run({ version: 0, notAField: 'nope' });

      expect(next).toHaveBeenCalledWith(expect.any(ZodError));
      const error = (next as jest.Mock).mock.calls[0][0] as ZodError;
      expect(error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    });

    it('passes a ZodError to next() for an unrecognized milestone field', () => {
      const { next } = run({
        version: 0,
        milestones: [{ title: 'M1', description: 'd', amount: 10, bogus: 1 }],
      });

      expect(next).toHaveBeenCalledWith(expect.any(ZodError));
    });
  });

  describe('bounded values', () => {
    it('passes a ZodError to next() when terms exceeds the max length', () => {
      const { next } = run({ version: 0, terms: 'a'.repeat(MAX_CONTRACT_TERMS_LENGTH + 1) });
      expect(next).toHaveBeenCalledWith(expect.any(ZodError));
    });

    it('passes a ZodError to next() when budget exceeds the maximum contract amount', () => {
      const { next } = run({ version: 0, budget: MAX_CONTRACT_AMOUNT_STROOPS + 1 });
      expect(next).toHaveBeenCalledWith(expect.any(ZodError));
    });

    it('passes a ZodError to next() for a wrong-typed field', () => {
      const { next } = run({ version: 0, status: 'not_a_status' });
      expect(next).toHaveBeenCalledWith(expect.any(ZodError));
    });
  });

  describe('successful validation', () => {
    it('calls next() with no error and attaches the parsed body', () => {
      const { req, next } = run({ version: 0, title: 'Valid Title Here' });

      expect(next).toHaveBeenCalledWith();
      expect(req.body).toEqual({ version: 0, title: 'Valid Title Here' });
    });

    it('accepts a dispute status transition with a bounded terms update', () => {
      const { req, next } = run({
        version: 2,
        status: 'disputed',
        terms: 'Escrow frozen pending review.',
      });

      expect(next).toHaveBeenCalledWith();
      expect(req.body).toMatchObject({ status: 'disputed' });
    });

    it('applies the milestone completed default when omitted', () => {
      const { req, next } = run({
        version: 0,
        milestones: [{ title: 'M1', description: 'd', amount: 10 }],
      });

      expect(next).toHaveBeenCalledWith();
      expect((req.body as any).milestones[0].completed).toBe(false);
    });

    // Milestone count is enforced downstream by the service-layer
    // contract_bounds_error (422) check, not by this schema — see the
    // comment on updateContractSchema.
    it('lets a body with many milestones reach the service layer unrejected', () => {
      const milestones = Array.from({ length: 25 }, (_, i) => ({
        title: `M${i}`,
        description: 'd',
        amount: 1,
      }));
      const { next } = run({ version: 0, milestones });

      expect(next).toHaveBeenCalledWith();
    });
  });
});
