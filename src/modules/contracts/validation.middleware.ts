/**
 * Validates the request body for contract update (PATCH) requests.
 *
 * Enforces optimistic-concurrency version requirements:
 * - If `version` is absent from the body → MissingVersionError (400 ERR_MISSING_VERSION)
 * - If `version` is present but not a non-negative integer → InvalidVersionError (400 ERR_INVALID_VERSION)
 * - If `version` is valid but other fields fail schema validation → passes ZodError to next handler
 *
 * @security The version check cannot be bypassed because it runs before schema parsing.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { updateContractSchema } from './dto/contract.dto';
import { MissingVersionError, InvalidVersionError } from '../../errors/appError';

export function validateUpdateContract(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown>;

  // 1. version absent entirely — this is the most common client mistake
  if (!('version' in body)) {
    return next(new MissingVersionError());
  }

  // 2. version present — check it is a non-negative integer before any other validation
  const versionResult = z.number().int().min(0).safeParse(body['version']);
  if (!versionResult.success) {
    return next(new InvalidVersionError());
  }

  // 3. Parse the full body against the schema (version already validated, but re-check for safety)
  const bodySchema = updateContractSchema.shape.body;
  const result = bodySchema.safeParse(body);

  if (!result.success) {
    // Check if version itself re-fails (shouldn't happen due to pre-check, but guard anyway)
    const versionIssue = result.error.issues.find(
      (issue) => issue.path.length > 0 && issue.path[0] === 'version',
    );
    if (versionIssue) {
      return next(new InvalidVersionError());
    }
    // Non-version field errors: pass through as ZodError for the global handler
    return next(result.error);
  }

  // Valid — attach parsed body and continue
  req.body = result.data;
  next();
}
