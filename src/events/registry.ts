import { EventIngestionConfig, EventIngestionService } from './eventIngestionService';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';
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
export const eventAuditRepository = new InMemoryEventAuditRepository();
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
export const eventAuditService = new EventAuditService(
  eventAuditRepository,
  console,
  finalityEvaluator,
);
export const eventIngestionService = new EventIngestionService(eventAuditService, defaultConfig);
