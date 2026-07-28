/**
 * Webhook DLQ (Dead Letter Queue) Storage
 * 
 * Persists failed webhook deliveries to durable SQLite storage for later inspection and replay.
 * Implements deduplication to prevent duplicate reprocessing on replay.
 * 
 * Capacity Management:
 * - Default max capacity: 10000 entries
 * - Overflow policy: oldest-evict (removes oldest entry when at capacity)
 * 
 * Poison Message Handling:
 * - Max replay attempts: 5 (configurable)
 * - Messages exceeding max attempts are permanently dropped
 * 
 * @module queue/webhook-dlq
 */

import DatabaseConstructor from '../db/betterSqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import * as crypto from 'crypto';
import { Counter, Registry } from 'prom-client';
import { DLQOperation } from '../webhookMetrics';

export interface WebhookDLQEntry {
  id: string;
  webhookId: string;
  url: string;
  body: Record<string, unknown>;
  retryCount: number;
  webhookSecret?: string;
  failedAt: string;
  lastError: string;
  dedupeKey: string;
  replayedAt?: string;
  replayAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDLQQuery {
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
}

export interface ReplayResult {
  success: boolean;
  entryId: string;
  deduplicated: boolean;
  message?: string;
}

export interface DLQConfig {
  maxCapacity: number;
  maxReplayAttempts: number;
}

const DEFAULT_DLQ_CONFIG: DLQConfig = {
  maxCapacity: 10000,
  maxReplayAttempts: 5,
};

let dlqMetricsCounter: Counter<string> | null = null;

export function initializeDLQMetrics(registry: Registry): void {
  if (dlqMetricsCounter) return;
  dlqMetricsCounter = new Counter({
    name: 'webhook_dlq_operations_total',
    help: 'Total number of DLQ operations',
    labelNames: ['operation'] as const,
    registers: [registry],
  });
}

export function resetDLQMetrics(): void {
  dlqMetricsCounter = null;
}

function incrementDLQMetric(operation: DLQOperation): void {
  if (dlqMetricsCounter) {
    dlqMetricsCounter.inc({ operation });
  }
}

class WebhookDLQStorage {
  private db: ReturnType<typeof DatabaseConstructor>;
  private config: DLQConfig;

  constructor(dbPath?: string, config: Partial<DLQConfig> = {}) {
    const resolvedPath = dbPath || process.env.WEBHOOK_DLQ_PATH || path.join(process.cwd(), 'data', 'webhook-dlq.db');
    this.db = new DatabaseConstructor(resolvedPath);
    this.config = { ...DEFAULT_DLQ_CONFIG, ...config };
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_dlq (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        url TEXT NOT NULL,
        body TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        webhook_secret TEXT,
        failed_at TEXT NOT NULL,
        last_error TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        replayed_at TEXT,
        replay_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(dedupe_key)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_dlq_failed_at ON webhook_dlq(failed_at)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_dlq_dedupe_key ON webhook_dlq(dedupe_key)
    `);

    // Migration: Add replay_attempts column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE webhook_dlq ADD COLUMN replay_attempts INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists, ignore
    }
  }

  private generateDedupeKey(webhookId: string, payload: Record<string, unknown>): string {
    const content = `${webhookId}:${JSON.stringify(payload)}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async addEntry(
    webhookId: string,
    url: string,
    body: Record<string, unknown>,
    retryCount: number,
    lastError: string,
    webhookSecret?: string
  ): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const dedupeKey = this.generateDedupeKey(webhookId, body);

    // Check capacity and evict oldest if necessary
    const currentCount = await this.getPendingCount();
    if (currentCount >= this.config.maxCapacity) {
      await this.evictOldest();
      incrementDLQMetric('drop_overflow');
    }

    const stmt = this.db.prepare(`
      INSERT INTO webhook_dlq (
        id, webhook_id, url, body, retry_count, webhook_secret,
        failed_at, last_error, dedupe_key, replay_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        id,
        webhookId,
        url,
        JSON.stringify(body),
        retryCount,
        webhookSecret || null,
        now,
        lastError,
        dedupeKey,
        0,
        now,
        now
      );
      incrementDLQMetric('enqueue');
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string };
      if (sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('DUPLICATE_ENTRY');
      }
      throw err;
    }

    return id;
  }

  private async getPendingCount(): Promise<number> {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM webhook_dlq WHERE replayed_at IS NULL');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  private async evictOldest(): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM webhook_dlq 
      WHERE id = (
        SELECT id FROM webhook_dlq 
        WHERE replayed_at IS NULL 
        ORDER BY failed_at ASC 
        LIMIT 1
      )
    `);
    stmt.run();
  }

  getEntry(id: string): WebhookDLQEntry | null {
    const stmt = this.db.prepare('SELECT * FROM webhook_dlq WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    
    if (!row) return null;
    
    return this.mapRowToEntry(row);
  }

  listEntries(query: WebhookDLQQuery = {}): WebhookDLQEntry[] {
    const { limit = 50, offset = 0, since, until } = query;
    
    let sql = 'SELECT * FROM webhook_dlq WHERE 1=1';
    const params: unknown[] = [];

    if (since) {
      sql += ' AND failed_at >= ?';
      params.push(since);
    }

    if (until) {
      sql += ' AND failed_at <= ?';
      params.push(until);
    }

    sql += ' ORDER BY failed_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    
    return rows.map(row => this.mapRowToEntry(row));
  }

  markReplayed(id: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE webhook_dlq SET replayed_at = ?, updated_at = ? WHERE id = ?
    `);
    
    const result = stmt.run(now, now, id);
    return result.changes > 0;
  }

  incrementReplayAttempts(id: string): { success: boolean; attempts: number; maxExceeded: boolean } {
    const entry = this.getEntry(id);
    if (!entry) {
      return { success: false, attempts: 0, maxExceeded: false };
    }

    const newAttempts = entry.replayAttempts + 1;
    const maxExceeded = newAttempts >= this.config.maxReplayAttempts;

    if (maxExceeded) {
      // Drop the poison message permanently
      this.deleteEntry(id);
      incrementDLQMetric('drop_poison');
      return { success: true, attempts: newAttempts, maxExceeded: true };
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE webhook_dlq SET replay_attempts = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(newAttempts, now, id);
    
    return { success: true, attempts: newAttempts, maxExceeded: false };
  }

  getMaxReplayAttempts(): number {
    return this.config.maxReplayAttempts;
  }

  deleteEntry(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM webhook_dlq WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  checkDedupe(webhookId: string, body: Record<string, unknown>): { exists: boolean; entryId?: string } {
    const dedupeKey = this.generateDedupeKey(webhookId, body);
    const stmt = this.db.prepare('SELECT id FROM webhook_dlq WHERE dedupe_key = ? AND replayed_at IS NULL');
    const row = stmt.get(dedupeKey) as { id: string } | undefined;
    
    return {
      exists: !!row,
      entryId: row?.id
    };
  }

  async getStats(): Promise<{ total: number; pending: number; replayed: number }> {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM webhook_dlq');
    const pendingStmt = this.db.prepare('SELECT COUNT(*) as count FROM webhook_dlq WHERE replayed_at IS NULL');
    const replayedStmt = this.db.prepare('SELECT COUNT(*) as count FROM webhook_dlq WHERE replayed_at IS NOT NULL');
    
    const total = (totalStmt.get() as { count: number }).count;
    const pending = (pendingStmt.get() as { count: number }).count;
    const replayed = (replayedStmt.get() as { count: number }).count;
    
    return { total, pending, replayed };
  }

  close(): void {
    this.db.close();
  }

  private mapRowToEntry(row: Record<string, unknown>): WebhookDLQEntry {
    return {
      id: row.id as string,
      webhookId: row.webhook_id as string,
      url: row.url as string,
      body: JSON.parse(row.body as string),
      retryCount: row.retry_count as number,
      webhookSecret: row.webhook_secret as string | undefined,
      failedAt: row.failed_at as string,
      lastError: row.last_error as string,
      dedupeKey: row.dedupe_key as string,
      replayedAt: row.replayed_at as string | undefined,
      replayAttempts: (row.replay_attempts as number) ?? 0,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

let instance: WebhookDLQStorage | null = null;
export { WebhookDLQStorage };

export function getWebhookDLQStorage(dbPath?: string): WebhookDLQStorage {
  // Under test, hand out an ephemeral in-memory store per call so unit tests
  // are isolated from one another and never read/write the on-disk DLQ file.
  if (process.env.NODE_ENV === 'test') {
    return new WebhookDLQStorage(dbPath ?? ':memory:');
  }
  if (!instance) {
    instance = new WebhookDLQStorage(dbPath);
  }
  return instance;
}

export function clearWebhookDLQInstance(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}