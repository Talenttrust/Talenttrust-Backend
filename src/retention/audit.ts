/**
 * Compliance Audit Logging Service
 * 
 * Tracks all data retention, archival, and deletion actions for
 * compliance auditing, regulatory reporting, and forensic analysis.
 * 
 * @module retention/audit
 */

import { ComplianceAuditLog, RetentionAction, DataEntityType } from './types';

/**
 * Compliance audit log entry builder
 * @interface AuditLogEntry
 */
export interface AuditLogEntry {
  entityId: string;
  entityType: DataEntityType;
  action: RetentionAction;
  actor: string;
  details: Record<string, unknown>;
  compliance?: string;
  notes?: string;
}

/**
 * Audit log query filter options
 * @interface AuditLogFilter
 */
export interface AuditLogFilter {
  entityId?: string;
  entityType?: DataEntityType;
  action?: RetentionAction;
  actor?: string;
  compliance?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Compliance audit logging service
 * 
 * Maintains immutable audit logs of all retention-related operations
 * for compliance verification and forensic investigation.
 * 
 * @class ComplianceAuditLogger
 */
export class ComplianceAuditLogger {
  private auditLogs: Map<string, ComplianceAuditLog> = new Map();
  private logQueue: ComplianceAuditLog[] = [];
  private logIndex: Map<string, Set<string>> = new Map(); // entityId -> logIds

  /**
   * Log a retention-related action
   * 
   * Creates an immutable audit trail entry for retention operations,
   * useful for compliance verification and regulatory reporting.
   * 
   * @param {AuditLogEntry} entry - Audit log entry details
   * @returns {ComplianceAuditLog} Created audit log
   */
  logAction(entry: AuditLogEntry): ComplianceAuditLog {
    const auditLog: ComplianceAuditLog = {
      id: this.generateAuditLogId(),
      entityId: entry.entityId,
      entityType: entry.entityType,
      action: entry.action,
      actor: entry.actor,
      timestamp: new Date(),
      details: entry.details,
      compliance: entry.compliance || 'GENERAL',
      notes: entry.notes,
    };

    this.auditLogs.set(auditLog.id, auditLog);
    this.logQueue.push(auditLog);
    this.addToIndex(entry.entityId, auditLog.id);

    return auditLog;
  }

  /**
   * Retrieve audit logs for a specific data entity
   * 
   * Returns complete audit trail for a data entity, showing all
   * operations performed on it.
   * 
   * @param {string} entityId - Entity identifier
   * @returns {ComplianceAuditLog[]} All audit logs for entity
   */
  getLogsForEntity(entityId: string): ComplianceAuditLog[] {
    const logIds = this.logIndex.get(entityId);
    if (!logIds) return [];

    return Array.from(logIds)
      .map(id => this.auditLogs.get(id))
      .filter((log): log is ComplianceAuditLog => log !== undefined)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Query audit logs with filters
   * 
   * Searches audit logs based on multiple criteria for compliance
   * reporting and investigation.
   * 
   * @param {AuditLogFilter} filter - Query filters
   * @returns {ComplianceAuditLog[]} Matching audit logs
   */
  queryLogs(filter: AuditLogFilter): ComplianceAuditLog[] {
    let results = Array.from(this.auditLogs.values());

    if (filter.entityId) {
      results = results.filter(log => log.entityId === filter.entityId);
    }

    if (filter.entityType) {
      results = results.filter(log => log.entityType === filter.entityType);
    }

    if (filter.action) {
      results = results.filter(log => log.action === filter.action);
    }

    if (filter.actor) {
      results = results.filter(log => log.actor === filter.actor);
    }

    if (filter.compliance) {
      results = results.filter(log => log.compliance === filter.compliance);
    }

    if (filter.startDate) {
      results = results.filter(log => log.timestamp >= filter.startDate!);
    }

    if (filter.endDate) {
      results = results.filter(log => log.timestamp <= filter.endDate!);
    }

    return results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get audit log by ID
   * 
   * @param {string} logId - Audit log identifier
   * @returns {ComplianceAuditLog | undefined}
   */
  getLogById(logId: string): ComplianceAuditLog | undefined {
    return this.auditLogs.get(logId);
  }

  /**
   * Get compliance report for audit trail
   * 
   * Generates a summary report of retention and archival activities
   * grouped by compliance standard.
   * 
   * @returns {Record<string, {count: number; actions: Record<string, number>}>} Compliance report
   */
  getComplianceReport(): Record<string, { count: number; actions: Record<string, number> }> {
    const report: Record<string, { count: number; actions: Record<string, number> }> = {};

    for (const log of this.auditLogs.values()) {
      if (!report[log.compliance]) {
        report[log.compliance] = { count: 0, actions: {} };
      }

      report[log.compliance].count++;

      if (!report[log.compliance].actions[log.action]) {
        report[log.compliance].actions[log.action] = 0;
      }
      report[log.compliance].actions[log.action]++;
    }

    return report;
  }

  /**
   * Get audit trail summary for entity
   * 
   * @param {string} entityId - Entity identifier
   * @returns {{entity: string; firstAction: Date; lastAction: Date; actionCount: number; actions: string[]}}
   */
  getEntityAuditSummary(entityId: string): {
    entity: string;
    firstAction: Date;
    lastAction: Date;
    actionCount: number;
    actions: string[];
  } {
    const logs = this.getLogsForEntity(entityId);

    if (logs.length === 0) {
      return {
        entity: entityId,
        firstAction: new Date(),
        lastAction: new Date(),
        actionCount: 0,
        actions: [],
      };
    }

    const actions = Array.from(new Set(logs.map(log => log.action)));

    return {
      entity: entityId,
      firstAction: logs[0].timestamp,
      lastAction: logs[logs.length - 1].timestamp,
      actionCount: logs.length,
      actions,
    };
  }

  /**
   * Export audit logs as JSON for compliance reporting
   * 
   * @param {AuditLogFilter} [filter] - Optional filter criteria
   * @returns {ComplianceAuditLog[]} Audit logs as JSON-serializable array
   */
  exportLogs(filter?: AuditLogFilter): ComplianceAuditLog[] {
    const logs = filter ? this.queryLogs(filter) : Array.from(this.auditLogs.values());
    return logs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Clear audit logs (use with caution - for testing only)
   * 
   * @returns {void}
   */
  clearLogs(): void {
    this.auditLogs.clear();
    this.logQueue = [];
    this.logIndex.clear();
  }

  /**
   * Get total audit log count
   * 
   * @returns {number}
   */
  getLogCount(): number {
    return this.auditLogs.size;
  }

  /**
   * Add log ID to entity index
   * @private
   * @param {string} entityId - Entity identifier
   * @param {string} logId - Audit log identifier
   */
  private addToIndex(entityId: string, logId: string): void {
    if (!this.logIndex.has(entityId)) {
      this.logIndex.set(entityId, new Set());
    }
    this.logIndex.get(entityId)!.add(logId);
  }

  /**
   * Generate unique audit log ID
   * @private
   * @returns {string}
   */
  private generateAuditLogId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
