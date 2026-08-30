import { EventProcessingAudit, EventIngestionResult } from '../events/types';
import { PerContractEventOrdering } from '../events/ordering';
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
  /**
   * Demote finalized events within a ledger range back to provisional.
   * Used by the rewind service after a chain reorg is detected. Only
   * affects events whose `network` matches and whose `ledger` falls
   * within `[fromLedger, toLedger]`.
   *
   * @returns The number of events actually demoted.
   */
  demoteProvisional(network: string, fromLedger: number, toLedger: number): Promise<number>;
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

  async demoteProvisional(
    network: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<number> {
    let demoted = 0;
    for (const [key, audit] of this.audits.entries()) {
      if (
        audit.network === network &&
        audit.ledger !== undefined &&
        audit.ledger >= fromLedger &&
        audit.ledger <= toLedger &&
        audit.finalityStatus === 'finalized'
      ) {
        this.audits.set(key, {
          ...audit,
          finalityStatus: 'provisional',
          finalizedAt: undefined,
        });
        demoted++;
      }
    }
    return demoted;
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
    /**
     * Optional per-contract ordering gate. When present, events for the
     * same contract are applied strictly in `sequence` order: out-of-order
     * events are held (bounded) until the gap fills, and impossible jumps
     * or expired holds are rejected with a structured code. Omit for
     * passthrough (legacy) behaviour.
     */
    private readonly ordering?: PerContractEventOrdering,
  ) {}

  async processEvent(event: any, contractType: string, correlationId?: string): Promise<EventIngestionResult> {
    if (this.ordering) {
      return this.processEventOrdered(event, contractType, correlationId);
    }
    return this.processEventInternal(event, contractType, correlationId);
  }

  /**
   * Ordering-aware ingestion path: consult the gate, apply only in ledger
   * order, and drain the held buffer once a gap fills.
   */
  private async processEventOrdered(
    event: any,
    contractType: string,
    correlationId?: string,
  ): Promise<EventIngestionResult> {
    const processedAt = new Date();
    const deduplicationKey = DeduplicationManager.computeDeduplicationKey(event);
    const decision = this.ordering!.submit(event);

    if (decision.status === 'duplicate') {
      return {
        deduplicationKey,
        status: 'duplicate',
        reason: 'Event with same sequence already applied for this contract',
        processedAt,
      };
    }

    if (decision.status === 'rejected') {
      log.warn('Event rejected by per-contract ordering', {
        contractId: event.contractId,
        eventId: event.eventId,
        sequence: event.sequence,
        code: decision.code,
      });
      return {
        deduplicationKey,
        status: 'rejected',
        reason: decision.reason,
        processedAt,
        statusCode: decision.statusCode,
        code: decision.code,
      };
    }

    if (decision.status === 'held') {
      return {
        deduplicationKey,
        status: 'held',
        reason: 'Held for per-contract ordering; applied once the sequence gap fills',
        processedAt,
      };
    }

    const result = await this.processEventInternal(event, contractType, correlationId);
    this.ordering!.advanceTo(event.contractId, event.sequence);
    await this.drainOrderedEvents(event.contractId, contractType, correlationId);
    return result;
  }

  /**
   * Apply the contiguous run of held events whose predecessor has now been
   * applied, in ledger order. Each event is applied and only then advances
   * the high-water mark, so a failed apply re-holds the event instead of
   * being silently skipped.
   */
  private async drainOrderedEvents(
    contractId: string,
    contractType: string,
    correlationId?: string,
  ): Promise<void> {
    let next = this.ordering!.peekNext(contractId);
    while (next) {
      const held = this.ordering!.popNext(contractId)!;
      try {
        await this.processEventInternal(held.event, contractType, correlationId);
        this.ordering!.advanceTo(contractId, held.event.sequence);
      } catch (error) {
        // Re-hold so a later retry can apply it; never silently drop it.
        this.ordering!.submit(held.event);
        log.warn('Ordered held event failed to apply; re-held', {
          contractId,
          eventId: held.event.eventId,
          sequence: held.event.sequence,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        break;
      }
      next = this.ordering!.peekNext(contractId);
    }
  }

  /**
   * Expire held events that waited too long for their predecessor. Returns
   * the expired events so callers can surface them (they are recorded as
   * `ordering_gap_timeout` rejections in the gate snapshot).
   */
  public expireHeldOrderingEvents(now?: number): import('../events/ordering').ExpiredEvent[] {
    if (!this.ordering) return [];
    return this.ordering.expireHeld(now);
  }

  /**
   * Snapshot of the ordering gate (high-water marks, pending, rejections).
   * Empty snapshot when no gate is attached.
   */
  public getOrderingSnapshot(): import('../events/ordering').OrderingSnapshot | null {
    return this.ordering ? this.ordering.getSnapshot() : null;
  }

  /** The existing ingestion logic (validation-free; dedupe, finality, persist). */
  private async processEventInternal(event: any, contractType: string, correlationId?: string): Promise<EventIngestionResult> {
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
