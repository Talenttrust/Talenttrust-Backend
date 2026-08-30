import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, fail } from '../utils/apiResponse';
import { EventAuditService } from '../repository/eventAuditRepository';
import { validateContractEventPayload } from '../contracts/validation';
import { getCorrelationId } from '../utils/correlationId';
import { validateSchema } from '../middleware/validate.middleware';
import {
  EventIngestionBackpressure,
  DEFAULT_MAX_PENDING_EVENTS,
} from '../events/backpressure';
import { eventAuditService as sharedEventAuditService } from '../events/registry';
import { createTenantRateLimiter } from '../middleware/tenantRateLimiter';

export interface EventsRouterOptions {
  /**
   * Bounded admission gate for the ingestion pipeline. When omitted, a
   * default instance is created from EVENT_INGESTION_MAX_PENDING (default
   * 100). Inject a fresh instance in tests for deterministic state.
   */
  backpressure?: EventIngestionBackpressure;
}

const DEFAULT_BACKPRESSURE_MAX_PENDING = Number(
  process.env.EVENT_INGESTION_MAX_PENDING ?? DEFAULT_MAX_PENDING_EVENTS,
);

export function createEventsRouter(
  eventAuditService: EventAuditService = sharedEventAuditService,
  options: EventsRouterOptions = {},
): Router {
  const router = Router();
  const backpressure =
    options.backpressure ??
    new EventIngestionBackpressure({ maxPendingEvents: DEFAULT_BACKPRESSURE_MAX_PENDING });

  router.post('/events', eventRateLimiter, async (req: Request, res: Response) => {
    const validation = validateContractEventPayload(req.body);
    if (!validation.ok) {
      return fail(res, 'invalid_event_payload', validation.reason, 400);
    }

    const admission = backpressure.tryAdmit(validation.event);
    if (!admission.admitted) {
      res.setHeader('Retry-After', '1');
      return fail(
        res,
        'ingestion_backpressure',
        'Event ingestion is at capacity; retry shortly',
        429,
      );
    }

    try {
      const result = await eventAuditService.processEvent(
        validation.event,
        validation.event.type,
        getCorrelationId(res),
      );
      backpressure.complete(admission.token!, result.status);

      if (result.status === 'accepted') {
        return ok(
          res,
          {
            status: 'accepted',
            deduplicationKey: result.deduplicationKey,
          },
          undefined,
          202,
        );
      }

      if (result.status === 'duplicate') {
        return ok(res, {
          status: 'duplicate',
          deduplicationKey: result.deduplicationKey,
        });
      }

      return fail(
        res,
        result.code ?? 'event_rejected',
        result.reason ?? 'Event rejected',
        result.statusCode ?? 400,
      );
    } catch (_error) {
      backpressure.complete(admission.token!, 'error');
      return fail(res, 'internal_error', 'Failed to process event', 500);
    }
  });

  /**
   * Actionable ingestion health signals: queue depth, oldest event age,
   * rejected work, processing latency, and admission state. Lets operators
   * see backpressure building before queue loss instead of after.
   */
  router.get('/events/health', (_req: Request, res: Response) => {
    const health = backpressure.getHealth();
    return ok(
      res,
      health,
      undefined,
      health.healthy ? 200 : 503,
    );
  });

  router.post('/events/validate', (req: Request, res: Response) => {
    const validation = validateContractEventPayload(req.body);
    if (!validation.ok) {
      return fail(res, 'invalid_event_payload', validation.reason, 400);
    }

    return ok(res, {
      valid: true,
      event: validation.event,
    });
  });

  router.get('/events/stats', async (_req: Request, res: Response) => {
    const stats = await eventAuditService.getStatistics();
    return ok(res, stats);
  });

  router.get(
    '/contracts/:contractId/history',
    validateSchema(z.object({ params: z.object({ contractId: z.string().min(1) }) })),
    async (req: Request, res: Response) => {
      const { contractId } = req.params;
      const history = await eventAuditService.getEventHistory(contractId);
      return ok(res, history);
    },
  );

  return router;
}

export default createEventsRouter();
