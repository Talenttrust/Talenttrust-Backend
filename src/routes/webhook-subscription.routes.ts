import { Router, Response } from 'express';
import { getDb } from '../db/database';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';
import { validateSchema } from '../middleware/validate.middleware';
import { requireAuth, requireRole } from '../middleware/authorization';
import { decodeCursor } from '../contracts/cursor.repository';
import {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema,
  getWebhookSubscriptionSchema,
  listWebhookSubscriptionsQuerySchema,
  toCreateWebhookSubscriptionDto,
  toUpdateWebhookSubscriptionDto,
  toWebhookSubscriptionResponseDto,
  toListWebhookSubscriptionsQueryDto,
  bulkWebhookSubscriptionSchema,
  bulkWebhookItemSchema,
  type BulkWebhookItemResult,
} from '../modules/webhooks/dto/webhook-subscription.dto';
import { AuthenticatedRequest } from '../lib/types';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { validateWebhookUrl, findSubscriptionOrFail } from './webhook-subscription.validation';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { authRateLimitKeyFn } from '../auth/rateLimitKey';
import {
  WebhookSubscriptionCacheService,
  loadWebhookCacheConfig,
} from '../services/webhookSubscriptionCache.service';

const router = Router();

// DB and Repository setup is resolved at registration / execution time
const getRepo = () => new SqliteWebhookSubscriptionRepository(getDb());

const webhookRateLimiter = createRateLimiter({
  ...rateLimitConfig.webhooksApi,
  keyFn: authRateLimitKeyFn,
});

/**
 * Module-level cache singleton, configured from environment variables.
 * A separate Registry is used so these metrics are isolated from the global
 * MetricsService registry and do not cause duplicate-registration errors in
 * tests that spin up the app multiple times.
 */
const webhookCache = new WebhookSubscriptionCacheService(loadWebhookCacheConfig());

/**
 * Removes the webhook secret from a subscription object before sending to the client.
 * Secrets must never be exposed in API responses.
 */
function sanitizeSubscription(sub: any): any {
  const { secret: _secret, ...rest } = sub;
  return rest;
}

/**
 * POST /api/v1/webhook-subscriptions
 * Creates a new webhook subscription. Admins can create subscription for any consumer,
 * but let's restrict it to admin-only or authenticated users.
 */
router.post(
  '/',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  validateSchema(createWebhookSubscriptionSchema),
  idempotencyMiddleware,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { url } = req.body;
      if (!validateWebhookUrl(url, res)) return;

      const repo = getRepo();
      const createDto = toCreateWebhookSubscriptionDto(req.body);
      const subscription = await repo.create(createDto);

      // A new subscription changes every list result — purge all list keys.
      webhookCache.invalidateLists();

      res.status(201).json({
        status: 'success',
        data: toWebhookSubscriptionResponseDto(subscription),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/webhook-subscriptions/bulk
 *
 * Process up to MAX_WEBHOOK_BULK_BATCH_SIZE (25) subscription operations in one
 * request. Each item carries an explicit `operation` field:
 *   - "create" — mirrors POST /
 *   - "update" — mirrors PATCH /:id
 *   - "delete" — mirrors DELETE /:id
 *
 * Items are validated and executed independently. A failing item produces a
 * per-item error in the response without affecting other items.
 *
 * Response:
 *   200  { status: 'success',         results: [...] }  — all items succeeded
 *   207  { status: 'partial_failure', results: [...] }  — one or more items failed
 *   400  { error: { code, message } }                   — empty batch or over-cap
 *
 * Per-item result:
 *   { index, success: true,  data: WebhookSubscriptionResponseDto | { id, deleted } }
 *   { index, success: false, error: { code, message } }
 *
 * Cache invalidation runs once after all items are processed (not per item) to
 * avoid redundant cache churn. Per-id keys are evicted for mutated/deleted
 * subscriptions; list keys are evicted whenever any item succeeded.
 */
router.post(
  '/bulk',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  validateSchema(bulkWebhookSubscriptionSchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { items } = req.body as { items: unknown[] };

      const repo = getRepo();
      const results: BulkWebhookItemResult[] = [];

      // Track which subscription ids were mutated/deleted so we can
      // bulk-invalidate per-id cache keys in one pass after processing.
      const mutatedIds = new Set<string>();
      let anySucceeded = false;

      for (let i = 0; i < items.length; i++) {
        const raw = items[i];

        // Validate the individual item using the discriminated-union schema.
        // Invalid items get a per-item validation_error; the rest of the
        // batch continues unaffected.
        const parsed = bulkWebhookItemSchema.safeParse(raw);
        if (!parsed.success) {
          const firstIssue = parsed.error.issues[0];
          results.push({
            index: i,
            success: false,
            error: {
              code: 'validation_error',
              message: firstIssue?.message ?? 'Invalid item',
            },
          });
          continue;
        }

        const item = parsed.data;

        try {
          if (item.operation === 'create') {
            // SSRF-check the URL the same way the single-item POST does.
            const { isSafeUrl } = await import('../utils/ssrf');
            if (!isSafeUrl(item.url)) {
              results.push({
                index: i,
                success: false,
                error: {
                  code: 'invalid_url',
                  message: 'Provided URL is invalid or resolved to a private/reserved address.',
                },
              });
              continue;
            }

            const subscription = await repo.create(
              toCreateWebhookSubscriptionDto({
                url: item.url,
                eventType: item.eventType,
                ...(item.consumerId !== undefined && { consumerId: item.consumerId }),
                ...(item.secret !== undefined && { secret: item.secret }),
              }),
            );
            anySucceeded = true;
            results.push({
              index: i,
              success: true,
              data: toWebhookSubscriptionResponseDto(subscription),
            });

          } else if (item.operation === 'update') {
            // Validate URL if present.
            if (item.url !== undefined) {
              const { isSafeUrl } = await import('../utils/ssrf');
              if (!isSafeUrl(item.url)) {
                results.push({
                  index: i,
                  success: false,
                  error: {
                    code: 'invalid_url',
                    message: 'Provided URL is invalid or resolved to a private/reserved address.',
                  },
                });
                continue;
              }
            }

            // Check existence before attempting the update.
            const existing = await repo.findById(item.id);
            if (!existing) {
              results.push({
                index: i,
                success: false,
                error: { code: 'not_found', message: 'Webhook subscription not found.' },
              });
              continue;
            }

            const updated = await repo.update(
              item.id,
              toUpdateWebhookSubscriptionDto({
                ...(item.url !== undefined && { url: item.url }),
                ...(item.eventType !== undefined && { eventType: item.eventType }),
                ...(item.secret !== undefined && { secret: item.secret }),
                ...(item.active !== undefined && { active: item.active }),
              }),
            );
            mutatedIds.add(item.id);
            anySucceeded = true;
            results.push({
              index: i,
              success: true,
              data: toWebhookSubscriptionResponseDto(updated),
            });

          } else {
            // operation === 'delete'
            const existing = await repo.findById(item.id);
            if (!existing) {
              results.push({
                index: i,
                success: false,
                error: { code: 'not_found', message: 'Webhook subscription not found.' },
              });
              continue;
            }

            await repo.delete(item.id);
            mutatedIds.add(item.id);
            anySucceeded = true;
            results.push({
              index: i,
              success: true,
              data: { id: item.id, deleted: true },
            });
          }
        } catch (itemError) {
          // Unexpected per-item error — do not let it abort the rest of the batch.
          results.push({
            index: i,
            success: false,
            error: {
              code: 'internal_error',
              message: itemError instanceof Error ? itemError.message : 'An unexpected error occurred',
            },
          });
        }
      }

      // --- Cache invalidation (once per batch, not once per item) ---
      // Invalidate per-id keys for every subscription that was mutated or deleted.
      for (const id of mutatedIds) {
        webhookCache.invalidateSubscription(id);
      }
      // If any item succeeded, all list results are potentially stale.
      if (anySucceeded) {
        webhookCache.invalidateLists();
      }

      const failures = results.filter((r) => !r.success);
      const statusCode = failures.length === 0 ? 200 : 207;

      res.status(statusCode).json({
        status: statusCode === 200 ? 'success' : 'partial_failure',
        results,
        summary: {
          total: items.length,
          succeeded: results.filter((r) => r.success).length,
          failed: failures.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/webhook-subscriptions
 * Lists subscriptions with filter and cursor-based pagination support.
 * Results are served from cache when available.
 */
router.get(
  '/',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  validateSchema(listWebhookSubscriptionsQuerySchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const repo = getRepo();
      const query = toListWebhookSubscriptionsQueryDto(req.query as any);
      const { cursor: cursorStr, limit, ...filters } = query;

      if (cursorStr !== undefined) {
        try {
          decodeCursor(cursorStr);
        } catch (err) {
          return res.status(400).json({
            error: {
              code: 'invalid_cursor',
              message: (err as Error).message,
              requestId: res.locals.requestId || 'unknown',
            },
          });
        }
      }

      const filter = {
        consumerId: filters.consumerId,
        eventType: filters.eventType,
        active: filters.active,
      };

      // Serve from cache; on miss the fetcher calls the repository directly.
      const page = await webhookCache.getList(
        { ...filter, cursor: cursorStr, limit: limit as number | undefined },
        () =>
          repo.findAllPaginated(filter, {
            cursor: cursorStr,
            limit: limit as number | undefined,
          }),
      );

      res.status(200).json({
        status: 'success',
        data: page.data.map(sanitizeSubscription),
        meta: {
          nextCursor: page.nextCursor,
          hasNextPage: page.hasNextPage,
          limit: page.limit,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/webhook-subscriptions/:id
 * Retrieves a single subscription. Result is served from cache when available.
 */
router.get(
  '/:id',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  validateSchema(getWebhookSubscriptionSchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const repo = getRepo();

      // Serve from cache; on miss the fetcher calls findById on the repo.
      const subscription = await webhookCache.getById(id, () => repo.findById(id));

      if (!subscription) {
        res.status(404).json({
          error: {
            code: 'not_found',
            message: 'Webhook subscription not found.',
            requestId: res.locals?.requestId || 'unknown',
          },
        });
        return;
      }

      res.status(200).json({
        status: 'success',
        data: toWebhookSubscriptionResponseDto(subscription),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/v1/webhook-subscriptions/:id
 * Updates a subscription. Invalidates both the per-id key and all list keys.
 */
router.patch(
  '/:id',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  validateSchema(updateWebhookSubscriptionSchema),
  idempotencyMiddleware,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const { url } = req.body;

      if (url !== undefined && !validateWebhookUrl(url, res)) return;

      const repo = getRepo();
      const existing = await findSubscriptionOrFail(id, repo, res);
      if (!existing) return;

      const updateDto = toUpdateWebhookSubscriptionDto(req.body);
      const updated = await repo.update(id, updateDto);

      // Invalidate the specific subscription key and all list keys.
      webhookCache.invalidateSubscription(id);
      webhookCache.invalidateLists();

      res.status(200).json({
        status: 'success',
        data: toWebhookSubscriptionResponseDto(updated),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/webhook-subscriptions/:id
 * Deletes a subscription. Invalidates both the per-id key and all list keys.
 */
router.delete(
  '/:id',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  validateSchema(getWebhookSubscriptionSchema),
  idempotencyMiddleware,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const repo = getRepo();
      if (!(await findSubscriptionOrFail(id, repo, res))) return;

      await repo.delete(id);

      // Invalidate the specific subscription key and all list keys.
      webhookCache.invalidateSubscription(id);
      webhookCache.invalidateLists();

      res.status(200).json({
        status: 'success',
        data: {
          id,
          deleted: true,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as webhookSubscriptionRouter };
export default router;
