import { buildEventKey, validateEventKeyFormat } from './dedupe';
import { ContractEventRepository, IngestAuditLog } from './repository';
import { IngestResult, PersistedContractEvent } from './types';
import { validateContractEventPayload } from './validation';
import { createHash } from 'crypto';

/**
 * @notice Configuration options for event processing.
 */
export interface ProcessorConfig {
  enableAuditLogging?: boolean;
  enablePayloadHashing?: boolean;
  maxProcessingTime?: number; // in milliseconds
}

/**
 * @notice Coordinates validation, dedupe, and persistence for inbound events.
 * @dev Provides comprehensive idempotency guarantees and audit trail.
 */
export class ContractEventProcessor {
  constructor(
    private readonly repository: ContractEventRepository,
    private readonly config: ProcessorConfig = {}
  ) {}

  async ingest(payload: unknown): Promise<IngestResult> {
    const startTime = Date.now();
    const receivedAt = new Date().toISOString();
    
    // Validate payload structure and content
    const validation = validateContractEventPayload(payload);
    if (!validation.ok) {
      const auditLog = this.createAuditLog(
        this.generateEventKeyFromPayload(payload),
        'invalid',
        validation.reason,
        receivedAt,
        startTime
      );
      
      if (this.config.enableAuditLogging) {
        await this.repository.saveAuditLog(auditLog);
      }
      
      return {
        status: 'invalid',
        reason: validation.reason,
      };
    }

    const eventKey = buildEventKey(validation.event);
    
    // Check for duplicates with enhanced validation
    if (await this.repository.hasEventKey(eventKey)) {
      const auditLog = this.createAuditLog(
        eventKey,
        'duplicate',
        'Event already processed',
        receivedAt,
        startTime
      );
      
      if (this.config.enableAuditLogging) {
        await this.repository.saveAuditLog(auditLog);
      }
      
      return {
        status: 'duplicate',
        eventKey,
      };
    }

    // Create persisted event with enhanced metadata
    const persistedEvent: PersistedContractEvent = {
      ...validation.event,
      eventKey,
      receivedAt,
    };

    // Save event with error handling
    try {
      await this.repository.saveEvent(persistedEvent);
      
      // Create audit log for successful ingestion
      const auditLog = this.createAuditLog(
        eventKey,
        'accepted',
        undefined,
        receivedAt,
        startTime,
        payload
      );
      
      if (this.config.enableAuditLogging) {
        await this.repository.saveAuditLog(auditLog);
      }

      return {
        status: 'accepted',
        eventKey,
      };
    } catch (error) {
      // Log persistence failure
      const auditLog = this.createAuditLog(
        eventKey,
        'invalid',
        `Persistence failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        receivedAt,
        startTime
      );
      
      if (this.config.enableAuditLogging) {
        await this.repository.saveAuditLog(auditLog);
      }
      
      throw error;
    }
  }

  async listEvents(): Promise<PersistedContractEvent[]> {
    return this.repository.listEvents();
  }

  async getEvent(eventKey: string): Promise<PersistedContractEvent | null> {
    if (!validateEventKeyFormat(eventKey)) {
      throw new Error('Invalid event key format');
    }
    
    return this.repository.getEvent(eventKey);
  }

  async getAuditLog(eventKey: string): Promise<IngestAuditLog | null> {
    if (!validateEventKeyFormat(eventKey)) {
      throw new Error('Invalid event key format');
    }
    
    return this.repository.getAuditLog(eventKey);
  }

  async listAuditLogs(limit: number = 100): Promise<IngestAuditLog[]> {
    return this.repository.listAuditLogs(limit);
  }

  async getAuditLogsByContractId(contractId: string): Promise<IngestAuditLog[]> {
    if (!contractId || contractId.trim().length === 0) {
      throw new Error('Contract ID is required');
    }
    
    return this.repository.getAuditLogsByContractId(contractId.trim());
  }

  /**
   * @notice Validates idempotency by attempting to re-ingest an event.
   * @dev Returns the same result as the original ingestion for true idempotency.
   */
  async validateIdempotency(payload: unknown): Promise<{
    originalResult: IngestResult;
    reingestResult: IngestResult;
    isIdempotent: boolean;
  }> {
    // First ingestion
    const originalResult = await this.ingest(payload);
    
    // Second ingestion (should be duplicate if first was accepted)
    const reingestResult = await this.ingest(payload);
    
    // Check idempotency
    const isIdempotent = 
      originalResult.status === reingestResult.status &&
      originalResult.eventKey === reingestResult.eventKey &&
      (originalResult.status !== 'accepted' || reingestResult.status === 'duplicate');
    
    return {
      originalResult,
      reingestResult,
      isIdempotent,
    };
  }

  private createAuditLog(
    eventKey: string,
    status: IngestResult['status'],
    reason: string | undefined,
    receivedAt: string,
    startTime: number,
    payload?: unknown
  ): IngestAuditLog {
    const processingTimeMs = Date.now() - startTime;
    const payloadHash = this.config.enablePayloadHashing && payload 
      ? this.simpleHash(JSON.stringify(payload))
      : undefined;

    return {
      eventKey,
      status,
      reason,
      receivedAt,
      payloadHash,
      processingTimeMs,
    };
  }

  private generateEventKeyFromPayload(payload: unknown): string {
    try {
      if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
        const p = payload as any;
        if (typeof p.contractId === 'string' && 
            typeof p.eventId === 'string' && 
            typeof p.sequence === 'number') {
          return `${p.contractId}:${p.eventId}:${p.sequence}`;
        }
      }
    } catch {
      // Fallback to generated key
    }
    
    return `unknown:unknown:${Date.now()}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }
}