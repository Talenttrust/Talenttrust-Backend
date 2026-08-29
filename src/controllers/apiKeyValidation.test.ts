import { NextFunction, Request, Response } from 'express';
import {
  requireApiKeyRequest,
  validateApiKeyRequest,
} from './apiKeyValidation';

function createResponse() {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  } as unknown as Response;

  (response.status as jest.Mock).mockReturnValue(response);
  return response;
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    ...overrides,
  } as unknown as Request;
}

describe('validateApiKeyRequest', () => {
  it('calls next for a request authenticated with user.id', () => {
    const request = createRequest({ user: { id: 'user-1' } });
    const response = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    validateApiKeyRequest(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('calls next for a request authenticated with user.userId', () => {
    const request = createRequest({ user: { userId: 'user-1' } });
    const response = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    validateApiKeyRequest(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing user', {}],
    ['missing user id', { user: {} }],
    ['empty user id', { user: { id: '   ' } }],
    ['non-string user id', { user: { id: 123 } }],
  ])('rejects when authentication is %s', (_description, requestOverrides) => {
    const request = createRequest(requestOverrides);
    const response = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    validateApiKeyRequest(request, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when a key id is not required', () => {
    const request = createRequest({ user: { id: 'user-1' } });
    const response = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    validateApiKeyRequest(request, response, next, { requireKeyId: false });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing id', {}],
    ['empty id', { id: '   ' }],
    ['non-string id', { id: 42 }],
  ])('rejects when the required key id is %s', (_description, params) => {
    const request = createRequest({
      user: { id: 'user-1' },
      params,
    });
    const response = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    validateApiKeyRequest(request, response, next, { requireKeyId: true });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'API key ID is required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts keyId as an alternative route parameter name', () => {
    const request = createRequest({
      user: { id: 'user-1' },
      params: { keyId: 'key-1' },
    });
    const response = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    validateApiKeyRequest(request, response, next, { requireKeyId: true });

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireApiKeyRequest', () => {
  it('returns middleware that delegates to the shared validator', () => {
    const request = createRequest({
      user: { id: 'user-1' },
      params: { id: 'key-1' },
    });
    const response = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    requireApiKeyRequest({ requireKeyId: true })(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
