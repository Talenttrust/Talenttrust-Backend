import { EventIngestionConfig, EventIngestionService } from './eventIngestionService';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';

const defaultConfig: EventIngestionConfig = {
  enableStrictValidation: process.env.ENABLE_STRICT_VALIDATION !== 'false',
  enablePayloadIntegrityCheck: process.env.ENABLE_PAYLOAD_INTEGRITY_CHECK !== 'false',
  maxEventAgeMs: Number(process.env.MAX_EVENT_AGE_MS ?? 86400000),
  batchSize: Number(process.env.EVENT_BATCH_SIZE ?? 100),
};

export const eventAuditRepository = new InMemoryEventAuditRepository();
export const eventAuditService = new EventAuditService(eventAuditRepository);
export const eventIngestionService = new EventIngestionService(eventAuditService, defaultConfig);
