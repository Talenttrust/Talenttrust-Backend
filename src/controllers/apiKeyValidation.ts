import { NextFunction, Request, Response } from 'express';

export interface AuthenticatedApiKeyRequest extends Request {
  user?: {
    id?: string;
    userId?: string;
    [key: string]: unknown;
  };
}

export interface ApiKeyValidationOptions {
  requireKeyId?: boolean;
}

/**
 * Validates the request preconditions shared by API-key handlers.
 *
 * The helper intentionally performs only the common request-level checks.
 * Handler-specific body validation remains in the handler so that existing
 * response codes and messages are preserved.
 */
export function validateApiKeyRequest(
  request: Request,
  response: Response,
  next: NextFunction,
  options: ApiKeyValidationOptions = {}
): void {
  const apiKeyRequest = request as AuthenticatedApiKeyRequest;
  const userId = apiKeyRequest.user?.id ?? apiKeyRequest.user?.userId;

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (options.requireKeyId) {
    const keyId = request.params?.id ?? request.params?.keyId;

    if (typeof keyId !== 'string' || keyId.trim().length === 0) {
      response.status(400).json({ error: 'API key ID is required' });
      return;
    }
  }

  next();
}

export function requireApiKeyRequest(options: ApiKeyValidationOptions = {}) {
  return (request: Request, response: Response, next: NextFunction): void => {
    validateApiKeyRequest(request, response, next, options);
  };
}
