import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, fail } from '../utils/apiResponse';
import { EventAuditService } from '../repository/eventAuditRepository';
import { validateContractEventPayload } from '../contracts/validation';
import { ContractEvent } from '../contracts/types';
import { classifySchemaVersion, LEGACY_SCHEMA_VERSION } from '../events/schemaVersion';
import {
  EventQuarantineStorage,
  getEventQuarantineStorage,
} from '../events/eventQuarantine';
import { getCorrelationId } from '../utils/correlationId';
import { validateSchema } from '../middleware/validate.middleware';
import { requireAuth, requireRole } from '../middleware/authorization';
import { auditService } from '../audit/service';
import { eventAuditService as sharedEventAuditService } from '../events/registry';

export interface EventsRouterOptions {
  /**
   * Quarantine store for events with unknown contract schema versions.
   * Defaults to the shared SQLite-backed store.
   */
  quarantineStorage?: EventQuarantineStorage;
  /**
   * Known contract schema versions. Defaults to the platform constants;
   * tests override to simulate a contract upgrade before replay.
   */
  knownSchemaVersions?: readonly number[];
}

/** Max events accepted in a single batch (one RPC page). */
export const MAX_EVENT_BATCH_SIZE = 100;

/**
 * Outcome of the boundary classification + quarantine step that runs before
 * an event reaches the audit service.
 */
type BoundaryOutcome =
  | { kind: 'process'; event: ContractEvent }
  | { kind: 'quarantined'; quarantineId: string; reason: string }
  | { kind: 'malformed'; reason: string };

/**
 * Validate + classify a raw event body at the ingestion boundary. Events
 * with a present-but-malformed schema version are rejected; events with a
 * valid-but-unknown version are retained in quarantine (redacted) instead of
 * entering projections that assume the older payload shape.
 */
function classifyAtBoundary(
  body: unknown,
  quarantine: EventQuarantineStorage,
  knownSchemaVersions: readonly number[],
): BoundaryOutcome {
  const validation = validateContractEventPayload(body);
  if (!validation.ok) {
    return { kind: 'malformed', reason: validation.reason };
  }

  const classification = classifySchemaVersion(validation.event.schemaVersion, knownSchemaVersions);
  if (classification.status === 'malformed') {
    return { kind: 'malformed', reason: classification.reason };
  }

  if (classification.status === 'unknown') {
    const quarantineId = quarantine.addEntry({
      contractId: validation.event.contractId,
      eventId: validation.event.eventId,
      sequence: validation.event.sequence,
      schemaVersion: classification.version,
      eventType: validation.event.type,
      payload: validation.event,
      reason: `Unknown contract schema version ${classification.version} (known: ${knownSchemaVersions.join(', ')})`,
    });
    return {
      kind: 'quarantined',
      quarantineId,
      reason: `Event from contract schema version ${classification.version} is not yet supported`,
    };
  }

  // known or absent (legacy → version 1): process normally.
  return { kind: 'process', event: validation.event };
}

function mapProcessedResult(
  res: Response,
  result: Awaited<ReturnType<EventAuditService['processEvent']>>,
) {
  if (result.status === 'accepted') {
    return ok(
      res,
      { status: 'accepted', deduplicationKey: result.deduplicationKey },
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
}

export function createEventsRouter(
  eventAuditService: EventAuditService = sharedEventAuditService,
  options: EventsRouterOptions = {},
): Router {
  const router = Router();
  const quarantine = options.quarantineStorage ?? getEventQuarantineStorage();
  const knownSchemaVersions = options.knownSchemaVersions ?? [LEGACY_SCHEMA_VERSION];

  router.post('/events', async (req: Request, res: Response) => {
    const boundary = classifyAtBoundary(req.body, quarantine, knownSchemaVersions);

    if (boundary.kind === 'malformed') {
      return fail(res, 'invalid_event_payload', boundary.reason, 400);
    }

    if (boundary.kind === 'quarantined') {
      return ok(
        res,
        {
          status: 'quarantined',
          quarantineId: boundary.quarantineId,
          reason: boundary.reason,
        },
        undefined,
        202,
      );
    }

    try {
      const result = await eventAuditService.processEvent(
        boundary.event,
        boundary.event.type,
        getCorrelationId(res),
      );
      return mapProcessedResult(res, result);
    } catch (_error) {
      return fail(res, 'internal_error', 'Failed to process event', 500);
    }
  });

  /**
   * Ingest a page of events (one RPC page / batch). Per-item isolation: one
   * malformed or unknown-version event never blocks the rest of the page.
   */
  router.post('/events/batch', async (req: Request, res: Response) => {
    const events = Array.isArray(req.body?.events) ? (req.body.events as unknown[]) : null;
    if (events === null) {
      return fail(res, 'invalid_event_payload', 'body.events must be an array', 400);
    }
    if (events.length === 0) {
      return fail(res, 'invalid_event_payload', 'body.events must not be empty', 400);
    }
    if (events.length > MAX_EVENT_BATCH_SIZE) {
      return fail(
        res,
        'event_batch_too_large',
        `Batch exceeds the maximum of ${MAX_EVENT_BATCH_SIZE} events`,
        400,
      );
    }

    const correlationId = getCorrelationId(res);
    const results = [];
    for (let index = 0; index < events.length; index++) {
      const boundary = classifyAtBoundary(events[index], quarantine, knownSchemaVersions);

      if (boundary.kind === 'malformed') {
        results.push({ index, status: 'rejected', code: 'invalid_event_payload', reason: boundary.reason });
        continue;
      }
      if (boundary.kind === 'quarantined') {
        results.push({ index, status: 'quarantined', quarantineId: boundary.quarantineId, reason: boundary.reason });
        continue;
      }

      try {
        const result = await eventAuditService.processEvent(boundary.event, boundary.event.type, correlationId);
        results.push({
          index,
          status: result.status,
          deduplicationKey: result.deduplicationKey,
          ...(result.code ? { code: result.code } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
      } catch (_error) {
        results.push({ index, status: 'rejected', code: 'internal_error', reason: 'Failed to process event' });
      }
    }

    return ok(res, { results, processedCount: results.filter((r) => r.status === 'accepted').length });
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

  // ── Admin: quarantine inspection & replay ─────────────────────────────────
  const adminOnly = [requireAuth, requireRole('admin')];

  router.get('/events/quarantine', ...adminOnly, (req: Request, res: Response) => {
    const limitQuery = req.query['limit'];
    const offsetQuery = req.query['offset'];
    const contractIdQuery = req.query['contractId'];
    const eventTypeQuery = req.query['eventType'];

    const limit = Math.min(Math.max(Number(limitQuery) || 50, 1), 100);
    const offset = Math.max(Number(offsetQuery) || 0, 0);

    const entries = quarantine.listEntries({
      limit,
      offset,
      contractId: typeof contractIdQuery === 'string' ? contractIdQuery : undefined,
      eventType: typeof eventTypeQuery === 'string' ? eventTypeQuery : undefined,
    });

    auditService.log({
      action: 'ADMIN_ACTION',
      severity: 'INFO',
      actor: (req as Request & { user?: { id?: string } }).user?.id ?? 'unknown',
      resource: 'events-quarantine',
      resourceId: 'all',
      metadata: { operation: 'view', count: entries.length, limit, offset },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    return ok(res, { entries, limit, offset, count: entries.length });
  });

  router.post('/events/quarantine/replay', ...adminOnly, async (req: Request, res: Response) => {
    const { quarantineId, reason } = (req.body ?? {}) as {
      quarantineId?: string;
      reason?: string;
    };

    if (
      !quarantineId ||
      typeof quarantineId !== 'string' ||
      !reason ||
      typeof reason !== 'string' ||
      reason.trim().length < 5
    ) {
      return fail(
        res,
        'invalid_request',
        'quarantineId and reason (min 5 chars) are required',
        400,
      );
    }

    const stored = quarantine.getPayload(quarantineId);
    if (!stored) {
      return fail(res, 'quarantine_not_found', `Quarantined event not found: ${quarantineId}`, 404);
    }

    // Re-run the boundary with the stored (redacted) event. If the version is
    // still unknown it re-quarantines; if support has shipped it processes.
    const boundary = classifyAtBoundary(stored.payload, quarantine, knownSchemaVersions);

    auditService.log({
      action: 'ADMIN_ACTION',
      severity: 'WARNING',
      actor: (req as Request & { user?: { id?: string } }).user?.id ?? 'unknown',
      resource: 'events-quarantine',
      resourceId: quarantineId,
      metadata: {
        operation: 'replay',
        reason: reason.trim(),
        contractId: stored.contractId,
        eventId: stored.eventId,
        schemaVersion: stored.schemaVersion ?? LEGACY_SCHEMA_VERSION,
      },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    if (boundary.kind === 'quarantined') {
      quarantine.incrementReplayAttempts(quarantineId);
      return ok(
        res,
        {
          status: 're-quarantined',
          originalQuarantineId: quarantineId,
          quarantineId: boundary.quarantineId,
          reason: boundary.reason,
        },
        undefined,
        202,
      );
    }

    if (boundary.kind === 'malformed') {
      return fail(res, 'invalid_event_payload', boundary.reason, 400);
    }

    try {
      const result = await eventAuditService.processEvent(
        boundary.event,
        boundary.event.type,
        getCorrelationId(res),
      );
      quarantine.markReplayed(quarantineId);
      return ok(
        res,
        {
          status: result.status,
          deduplicationKey: result.deduplicationKey,
          quarantineId,
          ...(result.reason ? { reason: result.reason } : {}),
        },
        undefined,
        result.status === 'accepted' ? 202 : 200,
      );
    } catch (_error) {
      return fail(res, 'internal_error', 'Failed to reprocess event', 500);
    }
  });

  return router;
}

export default createEventsRouter();
