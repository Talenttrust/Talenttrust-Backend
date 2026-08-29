import { EventProcessingAudit, EventIngestionResult } from '../events/types';
import { DeduplicationManager } from '../utils/deduplication';
import { redact, redactPayloadForLog } from '../events/redact';
import { FinalityEvaluator } from '../finality/finalityEvaluator';
import { FinalityStatus } from '../finality/types';
import { createLogger } from '../logger';

const IDEMPOTENCY_CONFLICT_CODE = 'IDEMPOTENCY_PAYLOAD_CONFLICT';

type Logger = Pick<Console, 'warn'>;

/** Structured logger for promotion/observability records (PII-safe). */
const log = createLogger({ service: 'event-audit' });

export interface IEventAuditRepository {
  findByDeduplicationKey(deduplicationKey: string): Promise<EventProcessingAudit | null>;
  save(audit: EventProcessingAudit): Promise<EventProcessingAudit>;
  findByContractId(contractId: string, limit?: number): Promise<EventProcessingAudit[]>;
  /**
   * Public read — returns only events that are safe to expose (not
   * provisional). Legacy records without a `finalityStatus` are treated
   * as finalized.
   */
  findFinalizedByContractId(contractId: string, limit?: number): Promise<EventProcessingAudit[]>;
  /**
   * Internal read — provisional events for a network (or all networks
   * when `network` is omitted). Used by the promotion sweep and the
   * admin-only observability endpoint.
   */
  findProvisional(network?: string): Promise<EventProcessingAudit[]>;
  /**
   * Flip a provisional event to finalized (one-way promotion). No-op
   * when the event is unknown.
   */
  markFinalized(deduplicationKey: string, finalizedAt: string): Promise<void>;
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

  async findFinalizedByContractId(
    contractId: string,
    limit: number = 100,
  ): Promise<EventProcessingAudit[]> {
    const audits = await this.findByContractId(contractId);
    return audits
      .filter((audit) => audit.finalityStatus !== 'provisional')
      .slice(0, limit);
  }

  async findProvisional(network?: string): Promise<EventProcessingAudit[]> {
    const audits = Array.from(this.audits.values()).filter((audit) => {
      if (audit.finalityStatus !== 'provisional') return false;
      if (network !== undefined && audit.network !== network) return false;
      return true;
    });
    return audits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async markFinalized(deduplicationKey: string, finalizedAt: string): Promise<void> {
    const audit = this.audits.get(deduplicationKey);
    if (!audit) return;
    this.audits.set(deduplicationKey, {
      ...audit,
      finalityStatus: 'finalized',
      finalizedAt,
    });
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
    private readonly finalityEvaluator?: FinalityEvaluator,
  ) {}

  async processEvent(event: any, contractType: string, correlationId?: string): Promise<EventIngestionResult> {
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

    // Evaluate finality for on-chain events. Off-chain events (no
    // ledger) and events ingested without an evaluator are treated as
    // finalized immediately, preserving existing behaviour.
    let finalityStatus: FinalityStatus = 'finalized';
    let finalizedAt: string | undefined;
    const isOnChain = event.ledger !== undefined || event.network !== undefined;
    if (isOnChain && this.finalityEvaluator) {
      const evaluation = await this.finalityEvaluator.evaluate({
        network: event.network,
        ledger: event.ledger,
      });
      finalityStatus = evaluation.status;
      if (evaluation.status === 'provisional') {
        log.warn('Event accepted as provisional (below finality depth)', {
          network: evaluation.network,
          ledger: evaluation.ledger,
          confirmations: evaluation.confirmations,
          depth: evaluation.depth,
          reason: evaluation.reason,
        });
      }
    }
    if (finalityStatus === 'finalized') {
      finalizedAt = processedAt.toISOString();
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
      createdAt: new Date(),
      ...(correlationId && { correlationId }),
      ...(event.network !== undefined && { network: event.network }),
      ...(event.ledger !== undefined && { ledger: event.ledger }),
      finalityStatus,
      ...(finalizedAt && { finalizedAt }),
    };

    await this.repository.save(audit);

    return {
      deduplicationKey,
      status: 'accepted',
      processedAt
    };
  }

  async rejectEvent(event: any, reason: string, correlationId?: string): Promise<EventIngestionResult> {
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
      createdAt: new Date(),
      ...(correlationId && { correlationId })
    };

    await this.repository.save(audit);

    return {
      deduplicationKey,
      status: 'rejected',
      reason,
      processedAt
    };
  }

  /**
   * Public contract history read — only finalized events are exposed.
   * Provisional events remain stored for auditability but are hidden
   * from consumers until they reach the network's finality depth.
   */
  async getEventHistory(contractId: string): Promise<EventProcessingAudit[]> {
    return this.repository.findFinalizedByContractId(contractId);
  }

  /**
   * Internal/admin read of provisional (not yet final) events.
   */
  async getProvisionalEvents(network?: string): Promise<EventProcessingAudit[]> {
    return this.repository.findProvisional(network);
  }

  /**
   * One-way promotion sweep: re-evaluate provisional events for a
   * network against the current chain head and flip those that have now
   * reached the finality depth to `finalized`.
   *
   * Idempotent (promoting an already-finalized event is a no-op), so it
   * is safe to run on every successful blockchain sync — retries and
   * re-orgs before finality simply keep the event provisional.
   *
   * The head is fetched ONCE per network so the sweep's side effects
   * stay bounded. When the provider is unavailable the sweep is skipped
   * (events stay provisional) and a structured warn is emitted — the
   * next sync retries the promotion.
   */
  async promoteProvisionalEvents(
    network: string,
  ): Promise<{ promoted: number; remaining: number }> {
    if (!this.finalityEvaluator) {
      return { promoted: 0, remaining: 0 };
    }

    const provisional = await this.repository.findProvisional(network);
    if (provisional.length === 0) {
      return { promoted: 0, remaining: 0 };
    }

    let headLedger: number;
    try {
      headLedger = await this.finalityEvaluator.getLatestHead(network);
    } catch (error) {
      log.warn('Finality promotion skipped: chain head unavailable', {
        network,
        error: error instanceof Error ? error.message : 'Unknown provider error',
      });
      return { promoted: 0, remaining: provisional.length };
    }

    let promoted = 0;
    const now = new Date().toISOString();
    for (const audit of provisional) {
      const evaluation = this.finalityEvaluator.evaluateWithHead(
        { network: audit.network, ledger: audit.ledger },
        headLedger,
      );
      if (evaluation.status === 'finalized') {
        await this.repository.markFinalized(audit.deduplicationKey, now);
        promoted += 1;
        log.info('Finality promotion: event reached finality depth', {
          network: audit.network,
          ledger: audit.ledger,
          confirmations: evaluation.confirmations,
          depth: evaluation.depth,
        });
      }
    }

    return { promoted, remaining: provisional.length - promoted };
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
