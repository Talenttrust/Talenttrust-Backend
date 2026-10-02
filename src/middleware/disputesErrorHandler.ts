/**
 * @module middleware/disputesErrorHandler
 * @description Centralized error handling middleware for disputes endpoints.
 *
 * This middleware normalizes dispute-specific errors (DisputeError from disputes.service)
 * into the standard API error contract used by the global error handler.
 * It ensures all disputes endpoints return consistent error responses with:
 * - machine-readable error codes
 * - safe, user-friendly messages
 * - requestId for tracing
 * - no internal implementation details leaked
 *
 * @remarks
 * Dispute-specific errors from the service layer are mapped to standard AppError
 * instances, which are then handled by the global error handler. This ensures
 * consistency across all API endpoints while allowing domain-specific error codes.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/appError';
import { DisputeError } from '../services/disputes.service';

/**
 * Maps dispute-specific error codes to standard HTTP status codes.
 */
const DISPUTE_ERROR_STATUS_MAP: Record<string, number> = {
  dispute_not_found: 404,
  invalid_state_transition: 400,
  internal_error: 500,
} as const;

/**
 * Maps dispute-specific error codes to safe, user-friendly messages.
 */
const DISPUTE_ERROR_MESSAGES: Record<string, string> = {
  dispute_not_found: 'The requested dispute was not found',
  invalid_state_transition: 'The requested state transition is not allowed',
  internal_error: 'An unexpected error occurred while processing the dispute',
} as const;

/**
 * Converts a DisputeError to an AppError for consistent error handling.
 *
 * @param error - The DisputeError from the service layer
 * @returns An AppError that the global error handler can process
 */
function mapDisputeErrorToAppError(error: DisputeError): AppError {
  const statusCode = DISPUTE_ERROR_STATUS_MAP[error.code] ?? 500;
  const message = DISPUTE_ERROR_MESSAGES[error.code] ?? 'An unexpected error occurred';
  
  return new AppError(statusCode, error.code, message, false);
}

/**
 * Disputes error handling middleware.
 *
 * Catches DisputeError instances from the service layer and converts them to
 * AppError instances that the global error handler can process consistently.
 * All other errors are passed through to the next error handler.
 *
 * @param error - The error object
 * @param req - Express request
 * @param res - Express response
 * @param next - Express next function
 */
export function disputesErrorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If this is a DisputeError, convert it to AppError for consistent handling
  if (error instanceof DisputeError) {
    const appError = mapDisputeErrorToAppError(error);
    return next(appError);
  }

  // Pass all other errors to the next error handler (global error handler)
  next(error);
}
