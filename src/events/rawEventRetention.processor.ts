/**
 * @module events/rawEventRetention.processor
 * @description BullMQ processor for the raw event retention job.
 *
 * Wraps {@link RawEventRetentionService} with queue-level concerns: payload
 * validation (terminal on invalid input), correlation-id propagation, and a
 * structured job result.
 *
 * Retry semantics:
 *  - Invalid payload → throws `InvalidJobPayloadError` (terminal).
 *  - Per-event failures are isolated inside the run (recorded as `failed`
 *    counters); the job itself succeeds with a structured summary, so a
 *    transient DB/RPC issue during one event does not fail the whole run.
 *  - The run is idempotent: archival upserts by `event_id` and purge happens
 *    only after a successful archive in the same transaction.
 */

import { z } from 'zod';
import { createLogger } from '../logger';
import { InvalidJobPayloadError } from '../queue/queue-errors';
import type { JobResult } from '../queue/types';
import {
  RawEventRetentionService,
  loadRawEventRetentionConfig,
  RAW_EVENT_NETWORKS,
  RAW_EVENT_RETENTION_MAX_PER_RUN,
  type RawEventProjectionVerifier,
} from './rawEventRetention';
import type { RawEventRetentionRepository } from './rawEventRetention.repository';

/** Zod schema for the retention job payload. */
export const rawEventRetentionPayloadSchema = z
  .object({
    network: z.enum(RAW_EVENT_NETWORKS).optional(),
    maxEvents: z.number().int().min(1).max(RAW_EVENT_RETENTION_MAX_PER_RUN).optional(),
    dryRun: z.boolean().optional(),
    correlationId: z.string().max(256).optional(),
    requestId: z.string().max(256).optional(),
  })
  .strict();

export type RawEventRetentionDependencies = {
  service?: RawEventRetentionService;
};

/**
 * Processes one raw event retention job.
 *
 * @param payload - Run configuration from the queue.
 * @param deps    - Optional injected dependencies (tests); defaults to the
 *                  production wiring.
 */
export async function processRawEventRetention(
  payload: unknown,
  deps: RawEventRetentionDependencies = {},
): Promise<JobResult> {
  const parsed = rawEventRetentionPayloadSchema.safeParse(payload);
  const correlationId = (payload as { correlationId?: string } | null)?.correlationId;
  const requestId = (payload as { requestId?: string } | null)?.requestId;

  const log = createLogger({
    processor: 'raw-event-retention',
    ...(correlationId && { correlationId }),
    ...(requestId && { requestId }),
  });

  if (!parsed.success) {
    log.warn('Raw event retention rejected: invalid payload', {
      issues: parsed.error.issues.map((i) => i.message),
    });
    throw new InvalidJobPayloadError(
      `Invalid raw event retention payload: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }

  const service =
    deps.service ?? createDefaultRawEventRetentionService();

  const summary = await service.run({
    ...(parsed.data.network !== undefined && { network: parsed.data.network }),
    ...(parsed.data.maxEvents !== undefined && { maxEvents: parsed.data.maxEvents }),
    ...(parsed.data.dryRun !== undefined && { dryRun: parsed.data.dryRun }),
    correlationId: parsed.data.correlationId,
    requestId: parsed.data.requestId,
  });

  log.info('Raw event retention job completed', {
    enabled: summary.enabled,
    dryRun: summary.dryRun,
    scanned: summary.scanned,
    archived: summary.archived,
    purged: summary.purged,
    held: summary.held,
    deferred: summary.deferred,
    alreadyArchived: summary.alreadyArchived,
    failed: summary.failed,
  });

  return {
    success: true,
    message: `Raw event retention completed: ${summary.scanned} scanned, ${summary.archived} archived, ${summary.purged} purged`,
    data: summary,
  };
}

/** Production wiring — lazily built so importing this module stays side-effect free. */
function createDefaultRawEventRetentionService(): RawEventRetentionService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDb } = require('../db/database') as {
    getDb: () => import('better-sqlite3').Database;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SqliteRawEventRetentionRepository } = require('./rawEventRetention.repository') as {
    SqliteRawEventRetentionRepository: new (
      db: import('better-sqlite3').Database,
    ) => RawEventRetentionRepository;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AuditBackedProjectionVerifier } = require('./rawEventRetention') as {
    AuditBackedProjectionVerifier: new () => RawEventProjectionVerifier;
  };

  return new RawEventRetentionService({
    repository: new SqliteRawEventRetentionRepository(getDb()),
    verifier: new AuditBackedProjectionVerifier(),
    config: loadRawEventRetentionConfig(),
  });
}
