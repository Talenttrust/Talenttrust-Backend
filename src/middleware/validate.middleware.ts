import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny, ZodError } from 'zod';

/**
 * @dev Validation middleware using Zod.
 * Validates the incoming Request against a provided Zod schema.
 * Prevents injection attacks and ensures payload conformity.
 * 
 * @param schema The Zod schema to validate against (body, query, params).
 * @returns An Express middleware function.
 */
export const validateSchema = (schema: ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          status: 'error',
          message: 'Validation failed',
          errors: error.issues,
        });
      }
      next(error);
    }
  };
};
