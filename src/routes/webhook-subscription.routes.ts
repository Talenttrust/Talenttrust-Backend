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
import { WebhookService } from '../services/webhook.service';

const router = Router();

// DB and Repository setup is resolved at registration / execution time
const getRepo = () => new SqliteWebhookSubscriptionRepository(getDb());

const webhookRateLimiter = createRateLimiter({
  ...rateLimitConfig.webhooksApi,
  keyFn: authRateLimitKeyFn,
});

/**
 * Removes the webhook secret from a subscription object before sending to the client.
 * Secrets must never be exposed in API responses.
 */
function sanitizeSubscription(sub: any): any {
  const { secret: _secret, ...rest } = sub;
  return rest;
}

// ── DLQ endpoints (must be defined before /:id routes to avoid routing conflicts) ──

/**
 * GET /api/v1/webhook-subscriptions/dlq
 * Lists all dead-lettered webhook events. Admin-only.
 * Returns public, secret-redacted views of DLQ entries.
 */
router.get(
  '/dlq',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  async (_req: AuthenticatedRequest, res: Response, next) => {
    try {
      const service = new WebhookService();
      const dlqEntries = service.getDLQ();
      const stats = await service.getDLQStats();
      res.status(200).json({
        status: 'success',
        data: dlqEntries,
        meta: {
          total: stats.total,
          pending: stats.pending,
          replayed: stats.replayed,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/v1/webhook-subscriptions/dlq/stats
 * Returns DLQ statistics. Admin-only.
 */
router.get(
  '/dlq/stats',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  async (_req: AuthenticatedRequest, res: Response, next) => {
    try {
      const service = new WebhookService();
      const stats = await service.getDLQStats();
      res.status(200).json({
        status: 'success',
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/v1/webhook-subscriptions/dlq/replay-all
 * Replays all pending DLQ entries with bounded concurrency. Admin-only.
 * Must be defined before /dlq/:id to avoid routing conflicts.
 */
router.post(
  '/dlq/replay-all',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  async (_req: AuthenticatedRequest, res: Response, next) => {
    try {
      const service = new WebhookService();
      const summary = await service.replayAll({ concurrency: 5 });
      res.status(200).json({
        status: 'success',
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/v1/webhook-subscriptions/dlq/:id
 * Gets a single DLQ entry by ID. Admin-only.
 * Returns 404 when the entry does not exist.
 */
router.get(
  '/dlq/:id',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const service = new WebhookService();
      const entry = await service.getDLQEntry(id);
      if (!entry) {
        return res.status(404).json({
          error: {
            code: 'not_found',
            message: 'DLQ entry not found',
            requestId: res.locals['requestId'] ?? 'unknown',
          },
        });
      }
      res.status(200).json({
        status: 'success',
        data: entry,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/v1/webhook-subscriptions/dlq/:id/replay
 * Replays a single DLQ entry. Admin-only.
 * Generates a fresh timestamp and HMAC signature for the replay delivery.
 * Returns 404 when the entry does not exist.
 */
router.post(
  '/dlq/:id/replay',
  webhookRateLimiter,
  requireAuth,
  requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const service = new WebhookService();
      const result = await service.replayDLQEntry(id);
      if (!result.success) {
        const statusCode = result.message === 'Entry not found' ? 404 : 422;
        return res.status(statusCode).json({
          error: {
            code: result.message === 'Entry not found' ? 'not_found' : 'replay_failed',
            message: result.message,
            requestId: res.locals['requestId'] ?? 'unknown',
          },
        });
      }
      res.status(200).json({
        status: 'success',
        data: { id, replayed: true, message: result.message },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ── Subscription CRUD endpoints ───────────────────────────────────────────────

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
 * Lists subscriptions with filter and cursor-based pagination support
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
      const page = await repo.findAllPaginated(filter, {
        cursor: cursorStr,
        limit: limit as number | undefined,
      });
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
 * Retrieves a single subscription
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
      const subscription = await findSubscriptionOrFail(id, repo, res);
      if (!subscription) return;

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
 * Updates a subscription
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
 * Deletes a subscription
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
