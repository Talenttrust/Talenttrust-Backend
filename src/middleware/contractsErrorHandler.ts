import { Request, Response, NextFunction } from 'express';
import { ContractBoundsError } from '../contracts/bounds';
import { SoftDeleteRetentionError } from '../utils/softDelete';
import { AppError } from '../errors/appError';
import { fail } from '../utils/apiResponse';

const CONTRACT_ERROR_STATUS_MAP: Record<string, number> = {
  contract_bounds_error: 422,
  bad_request: 400,
  soft_delete_retention_expired: 410,
} as const;

export function contractsErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof ContractBoundsError) {
    fail(res, 'contract_bounds_error', error.message, 422);
    return;
  }

  if (error instanceof SoftDeleteRetentionError) {
    fail(res, error.code, error.message, error.statusCode);
    return;
  }

  if (error instanceof AppError) {
    const statusCode = CONTRACT_ERROR_STATUS_MAP[error.code] ?? error.statusCode;
    fail(res, error.code, error.message, statusCode);
    return;
  }

  next(error);
}