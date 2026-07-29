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
