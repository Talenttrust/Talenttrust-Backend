import { PersistedContractEvent, IngestResult } from './types';

/**
 * @notice Audit log entry for tracking event ingestion outcomes.
 */
export interface IngestAuditLog {
  eventKey: string;
  status: IngestResult['status'];
  reason?: string;
  receivedAt: string;
  payloadHash?: string;
  processingTimeMs?: number;
}

/**
 * @notice Persistence interface for contract events with audit capabilities.
 * @dev Concrete implementations can swap in durable storage without changing semantics.
 */
export interface ContractEventRepository {
  hasEventKey(eventKey: string): Promise<boolean>;
  saveEvent(event: PersistedContractEvent): Promise<void>;
  listEvents(): Promise<PersistedContractEvent[]>;
  getEvent(eventKey: string): Promise<PersistedContractEvent | null>;
  saveAuditLog(log: IngestAuditLog): Promise<void>;
  getAuditLog(eventKey: string): Promise<IngestAuditLog | null>;
  listAuditLogs(limit?: number): Promise<IngestAuditLog[]>;
  getAuditLogsByContractId(contractId: string): Promise<IngestAuditLog[]>;
}

/**
 * @notice In-memory repository used for deterministic tests and local development.
 * @dev Implements full audit trail functionality for comprehensive tracking.
 */
export class InMemoryContractEventRepository implements ContractEventRepository {
  private readonly eventsByKey = new Map<string, PersistedContractEvent>();
  private readonly auditLogs = new Map<string, IngestAuditLog>();
  private readonly contractIdIndex = new Map<string, Set<string>>();

  async hasEventKey(eventKey: string): Promise<boolean> {
    return this.eventsByKey.has(eventKey);
  }

  async saveEvent(event: PersistedContractEvent): Promise<void> {
    this.eventsByKey.set(event.eventKey, event);
    
    // Update contract ID index for efficient queries
    const { contractId } = this.parseEventKey(event.eventKey);
    if (!this.contractIdIndex.has(contractId)) {
      this.contractIdIndex.set(contractId, new Set());
    }
    this.contractIdIndex.get(contractId)!.add(event.eventKey);
  }

  async listEvents(): Promise<PersistedContractEvent[]> {
    return Array.from(this.eventsByKey.values());
  }

  async getEvent(eventKey: string): Promise<PersistedContractEvent | null> {
    return this.eventsByKey.get(eventKey) || null;
  }

  async saveAuditLog(log: IngestAuditLog): Promise<void> {
    this.auditLogs.set(log.eventKey, log);
  }

  async getAuditLog(eventKey: string): Promise<IngestAuditLog | null> {
    return this.auditLogs.get(eventKey) || null;
  }

  async listAuditLogs(limit: number = 100): Promise<IngestAuditLog[]> {
    const logs = Array.from(this.auditLogs.values())
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    
    return logs.slice(0, limit);
  }

  async getAuditLogsByContractId(contractId: string): Promise<IngestAuditLog[]> {
    const eventKeys = this.contractIdIndex.get(contractId) || new Set();
    const logs: IngestAuditLog[] = [];
    
    for (const eventKey of eventKeys) {
      const log = this.auditLogs.get(eventKey);
      if (log) {
        logs.push(log);
      }
    }
    
    return logs.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
  }

  private parseEventKey(eventKey: string): { contractId: string; eventId: string; sequence: number } {
    const parts = eventKey.split(':');
    return {
      contractId: parts[0],
      eventId: parts[1],
      sequence: parseInt(parts[2], 10),
    };
  }

  // Helper methods for testing and cleanup
  clear(): void {
    this.eventsByKey.clear();
    this.auditLogs.clear();
    this.contractIdIndex.clear();
  }

  getStats(): {
    totalEvents: number;
    totalAuditLogs: number;
    uniqueContracts: number;
    acceptedEvents: number;
    duplicateEvents: number;
    invalidEvents: number;
  } {
    const auditLogs = Array.from(this.auditLogs.values());
    const stats = {
      totalEvents: this.eventsByKey.size,
      totalAuditLogs: this.auditLogs.size,
      uniqueContracts: this.contractIdIndex.size,
      acceptedEvents: auditLogs.filter(log => log.status === 'accepted').length,
      duplicateEvents: auditLogs.filter(log => log.status === 'duplicate').length,
      invalidEvents: auditLogs.filter(log => log.status === 'invalid').length,
    };
    
    return stats;
  }
}