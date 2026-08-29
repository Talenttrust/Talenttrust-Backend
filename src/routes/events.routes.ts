import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, fail } from '../utils/apiResponse';
import { EventAuditService } from '../repository/eventAuditRepository';
import { validateContractEventPayload } from '../contracts/validation';
import { getCorrelationId } from '../utils/correlationId';
import { validateSchema } from '../middleware/validate.middleware';
import { eventAuditService as sharedEventAuditService } from '../events/registry';

export function createEventsRouter(
  eventAuditService: EventAuditService = sharedEventAuditService,
): Router {
  const router = Router();

  // Expire any held ordering events whose gap never filled before handling
  // new traffic. Bounded sweep — each call examines only held entries.
  router.use('/events', (_req: Request, res: Response, next: import('express').NextFunction) => {
    const expired = eventAuditService.expireHeldOrderingEvents();
    if (expired.length > 0) {
      res.locals['expiredOrderingEvents'] = expired;
    }
    next();
  });

  router.post('/events', async (req: Request, res: Response) => {
    const validation = validateContractEventPayload(req.body);
    if (!validation.ok) {
      return fail(res, 'invalid_event_payload', validation.reason, 400);
    }

    try {
      const result = await eventAuditService.processEvent(
        validation.event,
        validation.event.type,
        getCorrelationId(res),
      );

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

      if (result.status === 'held') {
        return ok(
          res,
          {
            status: 'held',
            deduplicationKey: result.deduplicationKey,
            reason: result.reason,
          },
          undefined,
          202,
        );
      }

      return fail(
        res,
        result.code ?? 'event_rejected',
        result.reason ?? 'Event rejected',
        result.statusCode ?? 400,
      );
    } catch (_error) {
      return fail(res, 'internal_error', 'Failed to process event', 500);
    }
  });

  /**
   * Read-only ordering snapshot: high-water marks, held (pending) events per
   * contract, and recent rejections (gap too large, buffer full, hold
   * timeout). Lets operators see at a glance whether any contract stream is
   * stalled on a missing sequence.
   */
  router.get('/events/ordering', (_req: Request, res: Response) => {
    const snapshot = eventAuditService.getOrderingSnapshot();
    return ok(res, snapshot ?? { enabled: false });
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
