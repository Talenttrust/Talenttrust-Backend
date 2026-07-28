import { EventAuditService } from '../repository/eventAuditRepository';
import { ContractEvent } from './types';
import {
  EnvelopeValidationOptions,
  isRecord,
  validateEventEnvelopePreamble,
} from '../shared/eventEnvelopeValidation';

export interface EventIngestionConfig {
  enableStrictValidation: boolean;
  enablePayloadIntegrityCheck: boolean;
  maxEventAgeMs: number;
  batchSize: number;
}

export interface EventValidationError {
  field: string;
  message: string;
}

export interface EventValidationResult {
  isValid: boolean;
  errors: EventValidationError[];
}

export interface EventIngestionResult {
  deduplicationKey?: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
  processedAt: Date;
  code?: string;
}

function toTimestampNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Preamble options for the event-ingestion-service validator.
 * Mirrors the inline behaviour that used to live here:
 * - collect every failing field (`abortEarly: false`)
 * - accept numeric or numeric-string timestamps (`timestampRule: 'numeric'`)
 * - messages suffixed with a trailing `.`
 */
const INGESTION_PREAMBLE_OPTIONS = {
  rootErrorMessage: 'Event must be a JSON object.',
  messageSuffix: '.',
  timestampRule: 'numeric',
  abortEarly: false,
} satisfies EnvelopeValidationOptions;

export class EventIngestionService {
  constructor(
    private readonly auditService: EventAuditService,
    private readonly config: EventIngestionConfig,
  ) {}

  public async processEvent(
    event: ContractEvent,
    contractType: string,
    correlationId?: string,
  ): Promise<EventIngestionResult> {
    const validation = this.validateEvent(event, contractType);
    if (!validation.isValid) {
      return {
        status: 'rejected',
        reason: `Validation failed: ${validation.errors.map((error) => error.message).join('; ')}`,
        processedAt: new Date(),
      };
    }

    try {
      const response = await this.auditService.processEvent(event, contractType, correlationId);

      if (
        response.status === 'rejected' &&
        this.config.enablePayloadIntegrityCheck &&
        response.reason?.includes('already used')
      ) {
        return {
          deduplicationKey: response.deduplicationKey,
          status: 'rejected',
          reason: 'Payload integrity check failed: event payload does not match previously processed event.',
          processedAt: response.processedAt,
          code: response.code,
        };
      }

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error';
      return {
        status: 'rejected',
        reason: `Processing error: ${message}`,
        processedAt: new Date(),
      };
    }
  }

  public async processBatch(
    events: ContractEvent[],
    contractType: string,
    correlationId?: string,
  ): Promise<EventIngestionResult[]> {
    const batchSize = Math.max(1, this.config.batchSize);
    const results: EventIngestionResult[] = [];

    for (let index = 0; index < events.length; index += batchSize) {
      const batch = events.slice(index, index + batchSize);
      const chunkResults = await Promise.all(
        batch.map((event) => this.processEvent(event, contractType, correlationId)),
      );
      results.push(...chunkResults);
    }

    return results;
  }

  public validateEvent(event: unknown, contractType: string): EventValidationResult {
    const errors: EventValidationError[] = [];

    // Delegate the shared preamble to the helper. This produces the same
    // set of field errors as the previous inline implementation, with the
    // same messages and field names.
    const preambleErrors = validateEventEnvelopePreamble(event, INGESTION_PREAMBLE_OPTIONS);
    for (const err of preambleErrors) {
      errors.push({ field: err.field, message: err.message });
    }

    // Caller-specific follow-up: age check (numeric timestamp only) and
    // contract-type-specific payload shape. Both early-exit when `event`
    // is not a record, which the helper has already established.
    if (isRecord(event)) {
      const timestampNumber = toTimestampNumber(event.timestamp);
      if (
        timestampNumber !== null &&
        !preambleErrors.some((e) => e.field === 'timestamp') &&
        Date.now() - timestampNumber > this.config.maxEventAgeMs
      ) {
        errors.push({ field: 'timestamp', message: 'Event too old.' });
      }

      if (this.config.enableStrictValidation) {
        errors.push(...this.validateContractSpecificPayload(contractType, event.payload));
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  public async getStatistics(): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  }> {
    return this.auditService.getStatistics();
  }

  public async getContractHistory(contractId: string) {
    return this.auditService.getEventHistory(contractId);
  }

  private validateContractSpecificPayload(
    contractType: string,
    payload: unknown,
  ): EventValidationError[] {
    if (!isRecord(payload)) {
      return [];
    }

    if (contractType === 'talent_contract') {
      const errors: EventValidationError[] = [];
      if (typeof payload.talentId !== 'string' || payload.talentId.trim().length === 0) {
        errors.push({ field: 'payload.talentId', message: 'talentId is required for talent_contract events.' });
      }
      if (typeof payload.action !== 'string' || payload.action.trim().length === 0) {
        errors.push({ field: 'payload.action', message: 'action is required for talent_contract events.' });
      }
      return errors;
    }

    return [];
  }
}
