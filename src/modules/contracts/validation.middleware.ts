import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { updateContractSchema } from './dto/contract.dto';
import { MissingVersionError, InvalidVersionError } from '../../errors/appError';

/**
 * Validates the request body for contract update (PATCH) requests.
 *
 * - If `version` is absent from the body → calls next(new MissingVersionError())
 * - If `version` is present but not a non-negative integer → calls next(new InvalidVersionError())
 * - If valid → attaches parsed body to req.body and calls next()
 */
export function validateUpdateContract(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown>;

  // 1. version absent entirely
  if (!('version' in body)) {
    return next(new MissingVersionError());
  }

  // 2. version present — check it is a non-negative integer
  const versionResult = z.number().int().min(0).safeParse(body['version']);
  if (!versionResult.success) {
    return next(new InvalidVersionError());
  }

  // 3. Parse the full body against the schema
  const bodySchema = updateContractSchema.shape.body;
  const result = bodySchema.safeParse(body);

  if (!result.success) {
    // version passed but another field is invalid — still surface as InvalidVersionError
    // only if version itself re-fails (shouldn't happen here, but guard anyway)
    const versionIssue = result.error.issues.find(
      (issue) => issue.path.length > 0 && issue.path[0] === 'version',
    );
    if (versionIssue) {
      return next(new InvalidVersionError());
    }
    // Non-version field errors: pass through to next error handler as-is
    return next(result.error);
  }

  // Valid — attach parsed body and continue
  req.body = result.data;
  next();
}
