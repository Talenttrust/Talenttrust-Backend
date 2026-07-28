import { getDb } from '../db/database';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface PromotionRecord {
  id: string; // UUID
  environmentFrom: string;
  environmentTo: string;
  targetVersion: string;
  promotionId: string;
  initiatedBy: string;
  timestamp: string; // ISO
  status: 'SUCCESS' | 'FAILURE';
  error?: string;
}

export interface RollbackRecord {
  id: string;
  environment: string;
  targetVersion: string;
  rollbackId: string;
  initiatedBy: string;
  timestamp: string;
  status: 'SUCCESS' | 'FAILURE';
  error?: string;
}

function getDatabase(): Database {
  return getDb();
}

export function recordPromotion(record: PromotionRecord): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO deployment_history (
      id,
      environment_from,
      environment_to,
      target_version,
      promotion_id,
      initiated_by,
      timestamp,
      status,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.environmentFrom,
    record.environmentTo,
    record.targetVersion,
    record.promotionId,
    record.initiatedBy,
    record.timestamp,
    record.status,
    record.error ?? null,
  );
}

export function recordRollback(record: RollbackRecord): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO deployment_history (
      id,
      environment_from,
      environment_to,
      target_version,
      rollback_id,
      initiated_by,
      timestamp,
      status,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.environment,
    null,
    record.targetVersion,
    record.rollbackId,
    record.initiatedBy,
    record.timestamp,
    record.status,
    record.error ?? null,
  );
}

export function fetchHistory(environment: string): PromotionRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT * FROM deployment_history
    WHERE environment_from = ? OR environment_to = ?
    ORDER BY timestamp DESC
  `,
    )
    .all(environment, environment);
  // Map rows to PromotionRecord (ignore rollback-only rows where environment_to null)
  return rows.map((row: any) => ({
    id: row.id,
    environmentFrom: row.environment_from,
    environmentTo: row.environment_to,
    targetVersion: row.target_version,
    promotionId: row.promotion_id,
    initiatedBy: row.initiated_by,
    timestamp: row.timestamp,
    status: row.status,
    error: row.error,
  }));
}
