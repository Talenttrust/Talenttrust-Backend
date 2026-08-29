import { EventIngestionConfig, EventIngestionService } from './eventIngestionService';
import { EventAuditService } from '../repository/eventAuditRepository';
import { SqliteEventAuditRepository } from '../repository/sqliteEventAuditRepository';
import type { EventProcessingAudit } from './types';
import { getDb } from '../db/database';
import { createFinalityPolicy } from '../finality/policy';
import { FinalityEvaluator } from '../finality/finalityEvaluator';
import { createSorobanLatestLedgerProvider } from '../finality/providers';
import { validateEnv } from '../config/env.schema';

const defaultConfig: EventIngestionConfig = {
  enableStrictValidation: process.env.ENABLE_STRICT_VALIDATION !== 'false',
  enablePayloadIntegrityCheck: process.env.ENABLE_PAYLOAD_INTEGRITY_CHECK !== 'false',
  maxEventAgeMs: Number(process.env.MAX_EVENT_AGE_MS ?? 86400000),
  batchSize: Number(process.env.EVENT_BATCH_SIZE ?? 100),
};

/**
 * Shared event audit repository + service.
 *
 * The finality evaluator marks on-chain events provisional until they
 * accumulate the per-network confirmation depth, and public reads
 * (contract history) only expose finalized events. The evaluator
 * fetches the chain head from the Soroban RPC provider lazily — only
 * when an on-chain event with a positive finality depth is ingested.
 */
const env = validateEnv();
export const eventAuditRepository = new SqliteEventAuditRepository(getDb());
const finalityPolicy = createFinalityPolicy(
  {
    depths: env.FINALITY_DEPTHS,
    defaultDepth: env.FINALITY_DEFAULT_DEPTH,
    allowZeroConfirmation: env.FINALITY_ALLOW_ZERO_CONFIRMATION,
  },
  env.NODE_ENV,
);
const finalityEvaluator = new FinalityEvaluator(
  finalityPolicy,
  createSorobanLatestLedgerProvider(),
);

/**
 * Derive the entity projection for an accepted contract event.
 *
 * The projection is keyed by **entity identity** (the contract id), not the
 * event identity, so a contract can accumulate state across many events. The
 * retained `data` is the incoming event payload (the read-model advance) and
 * `lastEventId` is the event's deduplication key — a duplicate replay of the
 * same event is a no-op for the projection. Tenant scoping flows from the
 * event payload and defaults to the shared `default` tenant.
 *
 * This is a pure function: it performs no DB or network I/O, so only the two
 * writes in `persistEventAndProjection` sit inside the transaction.
 */
const contractProjectionBuilder = (
  event: { contractId: string; tenantId?: string; payload?: Record<string, unknown> },
  audit: EventProcessingAudit,
): import('../repository/sqliteEventAuditRepository').ProjectionWrite => ({
  entityId: event.contractId,
  tenantId: event.tenantId ?? 'default',
  data: JSON.stringify(event.payload ?? {}),
  version: 1,
  lastEventId: audit.deduplicationKey,
});

export const eventAuditService = new EventAuditService(
  eventAuditRepository,
  console,
  finalityEvaluator,
  contractProjectionBuilder,
);
export const eventIngestionService = new EventIngestionService(eventAuditService, defaultConfig);
