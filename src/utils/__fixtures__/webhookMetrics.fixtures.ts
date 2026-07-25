/**
 * Shared test fixtures for webhook metrics tests.
 *
 * @module utils/__fixtures__/webhookMetrics
 */

/** Sample hostnames for metric label testing. Never include real URLs. */
export const SAMPLE_HOSTS = {
  standard: 'api.example.com',
  withPort: 'api.example.com:8080',
  withPath: 'api.example.com/v1/hooks',
  withQuery: 'api.example.com?token=secret',
  withAuth: 'user:pass@api.example.com',
  subdomain: 'webhooks.partner.io',
  localhost: 'localhost',
} as const;

/** Sample HTTP status codes for metric label testing. */
export const SAMPLE_STATUS_CODES = {
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  rateLimited: 429,
  serverError: 500,
  badGateway: 502,
  unavailable: 503,
  timeout: 504,
} as const;