/**
 * Webhook DLQ (Dead Letter Queue) Storage
 * 
 * Persists failed webhook deliveries to durable SQLite storage for later inspection and replay.
 * Implements deduplication to prevent duplicate reprocessing on replay.
 * 
 * @module queue/webhook-dlq
 */

import Database from 'better-sqlite3';
import path from 'path';
import * as crypto from 'crypto';

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

class WebhookDLQStorage {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.WEBHOOK_DLQ_PATH || path.join(process.cwd(), 'data', 'webhook-dlq.db');
    this.db = new Database(resolvedPath);
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

    const stmt = this.db.prepare(`
      INSERT INTO webhook_dlq (
        id, webhook_id, url, body, retry_count, webhook_secret,
        failed_at, last_error, dedupe_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now,
        now
      );
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string };
      if (sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('DUPLICATE_ENTRY');
      }
      throw err;
    }

    return id;
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
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

let instance: WebhookDLQStorage | null = null;
export { WebhookDLQStorage };

export function getWebhookDLQStorage(dbPath?: string): WebhookDLQStorage {
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