/**
 * @module webhook-subscription.validation
 * @description Shared validation helpers consumed by webhook subscription route handlers.
 *
 * Extracts the repeated inline validation preambles (URL safety checks,
 * subscription-existence lookups) into tested, reusable helpers so every
 * handler uses the same rejection codes and error shapes.
 */

import { Response } from 'express';
import { isSafeUrl } from '../utils/ssrf';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';

/**
 * Validates that a webhook destination URL passes the SSRF guard.
 *
 * If the URL is unsafe (private IP, link-local, etc.) this helper sends a
 * `400 invalid_url` error and returns `false`. The caller should `return`
 * immediately after a failed validation to short-circuit the handler.
 *
 * @param url  - The URL to validate.
 * @param res  - Express response object used to send the error on failure.
 * @returns `true` when the URL is safe, `false` when a 400 response was sent.
 */
export function validateWebhookUrl(url: string, res: Response): boolean {
  if (!isSafeUrl(url)) {
    res.status(400).json({
      error: {
        code: 'invalid_url',
        message: 'Provided URL is invalid or resolved to a private/reserved address.',
        requestId: res.locals?.requestId || 'unknown',
      },
    });
    return false;
  }
  return true;
}

/**
 * Fetch-validates that a subscription exists by id.
 *
 * Looks up a webhook subscription via the repository. When the subscription
 * is not found the helper sends a `404 not_found` error and returns `null`.
 * On success the subscription object is returned so the caller can continue
 * processing without repeating the lookup or 404 shape.
 *
 * @param id   - The subscription UUID.
 * @param repo - The subscription repository instance.
 * @param res  - Express response object used to send the error on failure.
 * @returns The subscription record, or `null` when a 404 response was sent.
 */
export async function findSubscriptionOrFail(
  id: string,
  repo: SqliteWebhookSubscriptionRepository,
  res: Response,
): Promise<ReturnType<SqliteWebhookSubscriptionRepository['findById']> | null> {
  const subscription = await repo.findById(id);
  if (!subscription) {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Webhook subscription not found.',
        requestId: res.locals?.requestId || 'unknown',
      },
    });
    return null;
  }
  return subscription;
}
