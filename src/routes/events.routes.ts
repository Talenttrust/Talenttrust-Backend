import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, fail } from '../utils/apiResponse';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';
import { validateContractEventPayload } from '../contracts/validation';
import { getCorrelationId } from '../utils/correlationId';
import { validateSchema } from '../middleware/validate.middleware';

const defaultEventAuditService = new EventAuditService(new InMemoryEventAuditRepository());

export function createEventsRouter(
  eventAuditService: EventAuditService = defaultEventAuditService,
): Router {
  const router = Router();

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

      return fail(
        res,
        result.code ?? 'event_rejected',
        result.reason ?? 'Event rejected',
        result.statusCode ?? 400,
      );
    } catch (error) {
      return fail(res, 'internal_error', 'Failed to process event', 500);
    }
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
