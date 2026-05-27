import { EventProcessingAudit, EventIngestionResult } from '../events/types';
import { DeduplicationManager } from '../utils/deduplication';
import { redact, redactPayloadForLog } from '../events/redact';

const IDEMPOTENCY_CONFLICT_CODE = 'IDEMPOTENCY_PAYLOAD_CONFLICT';

type Logger = Pick<Console, 'warn'>;

export interface IEventAuditRepository {
  findByDeduplicationKey(deduplicationKey: string): Promise<EventProcessingAudit | null>;
  save(audit: EventProcessingAudit): Promise<EventProcessingAudit>;
  findByContractId(contractId: string, limit?: number): Promise<EventProcessingAudit[]>;
  findByStatus(status: 'accepted' | 'rejected' | 'duplicate', limit?: number): Promise<EventProcessingAudit[]>;
  getEventStatistics(): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  }>;
}

export class InMemoryEventAuditRepository implements IEventAuditRepository {
  private audits: Map<string, EventProcessingAudit> = new Map();
  private contractIdIndex: Map<string, Set<string>> = new Map();
  private statusIndex: Map<string, Set<string>> = new Map();

  async findByDeduplicationKey(deduplicationKey: string): Promise<EventProcessingAudit | null> {
    return this.audits.get(deduplicationKey) || null;
  }

  async save(audit: EventProcessingAudit): Promise<EventProcessingAudit> {
    this.audits.set(audit.deduplicationKey, audit);
    
    // Update contract ID index
    if (!this.contractIdIndex.has(audit.contractId)) {
      this.contractIdIndex.set(audit.contractId, new Set());
    }
    this.contractIdIndex.get(audit.contractId)!.add(audit.deduplicationKey);
    
    // Update status index
    if (!this.statusIndex.has(audit.status)) {
      this.statusIndex.set(audit.status, new Set());
    }
    this.statusIndex.get(audit.status)!.add(audit.deduplicationKey);
    
    return audit;
  }

  async findByContractId(contractId: string, limit: number = 100): Promise<EventProcessingAudit[]> {
    const deduplicationKeys = this.contractIdIndex.get(contractId) || new Set();
    const audits = Array.from(deduplicationKeys)
      .map(key => this.audits.get(key))
      .filter((audit): audit is EventProcessingAudit => audit !== undefined)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    
    return audits;
  }

  async findByStatus(status: 'accepted' | 'rejected' | 'duplicate', limit: number = 100): Promise<EventProcessingAudit[]> {
    const deduplicationKeys = this.statusIndex.get(status) || new Set();
    const audits = Array.from(deduplicationKeys)
      .map(key => this.audits.get(key))
      .filter((audit): audit is EventProcessingAudit => audit !== undefined)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    
    return audits;
  }

  async getEventStatistics(): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  }> {
    const total = this.audits.size;
    const accepted = (this.statusIndex.get('accepted') || new Set()).size;
    const rejected = (this.statusIndex.get('rejected') || new Set()).size;
    const duplicates = (this.statusIndex.get('duplicate') || new Set()).size;

    return { total, accepted, rejected, duplicates };
  }
}

export class EventAuditService {
  constructor(
    private repository: IEventAuditRepository,
    private logger: Logger = console,
  ) {}

  async processEvent(event: any, contractType: string): Promise<EventIngestionResult> {
    const deduplicationKey = DeduplicationManager.computeDeduplicationKey(event);
    const processedAt = new Date();
    const payloadHash = DeduplicationManager.computePayloadHash(event.payload);

    // Check for existing event
    const existingAudit = await this.repository.findByDeduplicationKey(deduplicationKey);
    if (existingAudit) {
      if (!DeduplicationManager.comparePayloadHashes(payloadHash, existingAudit.payloadHash)) {
        this.logger.warn(
          'Rejected conflicting event idempotency replay',
          redact({
            contractType,
            deduplicationKey,
            storedPayloadHash: existingAudit.payloadHash,
            receivedPayloadHash: payloadHash,
            receivedPayload: redactPayloadForLog(event.payload),
          }),
        );

        return {
          deduplicationKey,
          status: 'rejected',
          reason: 'Idempotency key was already used with a different event payload.',
          processedAt,
          statusCode: 409,
          code: IDEMPOTENCY_CONFLICT_CODE,
        };
      }

      return {
        deduplicationKey,
        status: 'duplicate',
        reason: 'Event with same deduplication key already processed',
        processedAt
      };
    }

    // Create audit record
    const audit: EventProcessingAudit = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      deduplicationKey,
      contractId: event.contractId,
      eventId: event.eventId,
      sequence: event.sequence,
      status: 'accepted',
      payloadHash,
      processedAt,
      createdAt: new Date()
    };

    await this.repository.save(audit);

    return {
      deduplicationKey,
      status: 'accepted',
      processedAt
    };
  }

  async rejectEvent(event: any, reason: string): Promise<EventIngestionResult> {
    const deduplicationKey = DeduplicationManager.computeDeduplicationKey(event);
    const processedAt = new Date();

    const audit: EventProcessingAudit = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      deduplicationKey,
      contractId: event.contractId,
      eventId: event.eventId,
      sequence: event.sequence,
      status: 'rejected',
      reason,
      payloadHash: DeduplicationManager.computePayloadHash(event.payload),
      processedAt,
      createdAt: new Date()
    };

    await this.repository.save(audit);

    return {
      deduplicationKey,
      status: 'rejected',
      reason,
      processedAt
    };
  }

  async getEventHistory(contractId: string): Promise<EventProcessingAudit[]> {
    return this.repository.findByContractId(contractId);
  }

  async getStatistics(): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  }> {
    return this.repository.getEventStatistics();
  }
}
