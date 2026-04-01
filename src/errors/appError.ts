export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/**
 * Application-level error with explicit status and machine-readable code.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly expose: boolean = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Normalizes thrown errors into a safe and consistent API response payload.
 */
export function mapErrorToPayload(error: unknown, requestId: string): { statusCode: number; payload: ErrorPayload } {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      payload: {
        error: {
          code: error.code,
          message: error.message,
          requestId,
        },
      },
    };
  }

  return {
    statusCode: 500,
    payload: {
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId,
      },
    },
  };
}
