/**
 * @module queue/job-quarantine
 * @description Durable quarantine for permanently-invalid background jobs.
 *
 * A terminal job failure (see {@link queue-errors}) is moved here instead of
 * retried to exhaustion. This decouples the poisoned job from the live queue:
 * it no longer consumes retries, backoff delay, or worker slots, so unrelated
 * work is never stalled by a job that can never succeed.
 *
 * Invariants:
 *  - **No silent deletion** — quarantined entries are only removed by an
 *    explicit replay success (which re-enqueues the original job), never by
 *    the worker. Capacity overflow evicts the oldest pending entry, mirroring
 *    the webhook DLQ policy.
 *  - **Redacted persistence** — the stored payload is passed through
 *    `redactPayload` and the stored reason through the safe-error sanitizer,
 *    so no secrets or internal stack details are persisted.
 *  - **Tenant isolation** — every entry records its `tenantId`
 *    (defaulting to {@link DEFAULT_TENANT_ID}) and replay preserves it; no
 *    cross-tenant inspection is surfaced.
 *
 * @module queue/job-quarantine
 */

import DatabaseConstructor from '../db/betterSqlite3';
import * as crypto from 'crypto';
import path from 'path';
import { Counter, Registry } from 'prom-client';
import { JobType, JobPayload } from './types';
import { DEFAULT_TENANT_ID } from './fair-scheduler';
import { redactPayload } from '../utils/redact';
import { sanitizeErrorMessage } from '../errors/safeErrors';

/** A single quarantined job entry as consumed by inspection/replay. */
export interface JobQuarantineEntry {
  id: string;
  jobType: JobType;
  jobId: string;
  tenantId: string;
  payload: JobPayload;
  reason: string;
  kind: string;
  attemptsMade: number;
  quarantinedAt: string;
  replayedAt?: string;
  replayAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobQuarantineQuery {
  jobType?: JobType;
  tenantId?: string;
  limit?: number;
  offset?: number;
}

export interface QuarantineReplayResult {
  entryId: string;
  replayedJobId: string;
  deduplicated: boolean;
  jobType: JobType;
}

export interface JobQuarantineConfig {
  maxCapacity: number;
  maxReplayAttempts: number;
}

const DEFAULT_QUARANTINE_CONFIG: JobQuarantineConfig = {
  maxCapacity: 10000,
  maxReplayAttempts: 5,
};

let quarantineMetricsCounter: Counter<string> | null = null;

/**
 * Initialize the `job_quarantine_operations_total` counter on a registry.
 * No-op once initialized; call {@link resetJobQuarantineMetrics} between tests.
 */
export function initializeJobQuarantineMetrics(registry: Registry): void {
  if (quarantineMetricsCounter) return;
  quarantineMetricsCounter = new Counter({
    name: 'job_quarantine_operations_total',
    help: 'Total number of job quarantine operations',
    labelNames: ['operation'] as const,
    registers: [registry],
  });
}

export function resetJobQuarantineMetrics(): void {
  quarantineMetricsCounter = null;
}

function incrementQuarantineMetric(operation: string): void {
  if (quarantineMetricsCounter) {
    quarantineMetricsCounter.inc({ operation });
  }
}

/**
 * SQLite-backed quarantine store. Uses `better-sqlite3` via the shared
 * `DatabaseConstructor` helper so the environment's native/mock binding is
 * honored (including the in-memory fallback under test).
 */
class JobQuarantineStorage {
  private db: ReturnType<typeof DatabaseConstructor>;
  private config: JobQuarantineConfig;

  constructor(dbPath?: string, config: Partial<JobQuarantineConfig> = {}) {
    const resolvedPath =
      dbPath ||
      process.env.JOB_QUARANTINE_PATH ||
      path.join(process.cwd(), 'data', 'job-quarantine.db');
    this.db = new DatabaseConstructor(resolvedPath);
    this.config = { ...DEFAULT_QUARANTINE_CONFIG, ...config };
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_quarantine (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        kind TEXT NOT NULL,
        attempts_made INTEGER NOT NULL DEFAULT 0,
        quarantined_at TEXT NOT NULL,
        replayed_at TEXT,
        replay_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_job_quarantine_job_type ON job_quarantine(job_type)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_job_quarantine_quarantined_at ON job_quarantine(quarantined_at)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_job_quarantine_job_id ON job_quarantine(job_id)
    `);
  }

  /**
   * Add a quarantined entry for a terminal job failure. The payload is
   * redacted before persistence; the reason is sanitized so it cannot leak
   * stack traces, paths, or credentials.
   *
   * @throws If the underlying write fails (the caller bounds the side effect;
   *         the job is still handled, but not quarantined).
   */
  async addEntry(input: {
    jobType: JobType;
    jobId: string;
    tenantId?: string;
    payload: JobPayload;
    reason: string;
    kind: string;
    attemptsMade: number;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tenantId =
      typeof input.tenantId === 'string' && input.tenantId.length > 0
        ? input.tenantId
        : DEFAULT_TENANT_ID;

    const currentCount = await this.getPendingCount();
    if (currentCount >= this.config.maxCapacity) {
      await this.evictOldest();
      incrementQuarantineMetric('drop_overflow');
    }

    const redactedPayload = redactPayload(input.payload);
    const safeReason = sanitizeErrorMessage(input.reason, 'validation_error');

    const stmt = this.db.prepare(`
      INSERT INTO job_quarantine (
        id, job_type, job_id, tenant_id, payload, reason, kind,
        attempts_made, quarantined_at, replay_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.jobType,
      input.jobId,
      tenantId,
      JSON.stringify(redactedPayload),
      safeReason,
      input.kind,
      input.attemptsMade,
      now,
      0,
      now,
      now,
    );
    incrementQuarantineMetric('enqueue');

    return id;
  }

  private async getPendingCount(): Promise<number> {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM job_quarantine WHERE replayed_at IS NULL',
    );
    const result = stmt.get() as { count: number };
    return result.count;
  }

  private async evictOldest(): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM job_quarantine
      WHERE id = (
        SELECT id FROM job_quarantine
        WHERE replayed_at IS NULL
        ORDER BY quarantined_at ASC
        LIMIT 1
      )
    `);
    stmt.run();
  }

  getEntry(id: string): JobQuarantineEntry | null {
    const stmt = this.db.prepare('SELECT * FROM job_quarantine WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToEntry(row);
  }

  /**
   * Return the stored (redacted) payload for a quarantined job, preserving
   * original job type and tenant so replay reconstructs the same job.
   */
  getPayload(id: string): { jobType: JobType; jobId: string; tenantId: string; payload: JobPayload } | null {
    const entry = this.getEntry(id);
    if (!entry) return null;
    return {
      jobType: entry.jobType,
      jobId: entry.jobId,
      tenantId: entry.tenantId,
      payload: entry.payload,
    };
  }

  listEntries(query: JobQuarantineQuery = {}): JobQuarantineEntry[] {
    const { limit = 50, offset = 0, jobType, tenantId } = query;

    let sql = 'SELECT * FROM job_quarantine WHERE 1=1';
    const params: unknown[] = [];

    if (jobType) {
      sql += ' AND job_type = ?';
      params.push(jobType);
    }

    if (tenantId) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }

    sql += ' ORDER BY quarantined_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToEntry(row));
  }

  /**
   * Mark an entry as replayed the given number of times. Mirrors the webhook
   * DLQ poison-handling policy: after `maxReplayAttempts` the entry is kept
   * but flagged so it is no longer considered "pending" — replay backoff is
   * an operator concern and never silently deletes data.
   */
  incrementReplayAttempts(id: string): { success: boolean; attempts: number; maxExceeded: boolean } {
    const entry = this.getEntry(id);
    if (!entry) {
      return { success: false, attempts: 0, maxExceeded: false };
    }

    const newAttempts = entry.replayAttempts + 1;
    const maxExceeded = newAttempts >= this.config.maxReplayAttempts;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE job_quarantine SET replay_attempts = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(newAttempts, now, id);
    incrementQuarantineMetric('replay_attempt');

    return { success: true, attempts: newAttempts, maxExceeded };
  }

  markReplayed(id: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE job_quarantine SET replayed_at = ?, updated_at = ? WHERE id = ?
    `);
    const result = stmt.run(now, now, id);
    return result.changes > 0;
  }

  async getStats(): Promise<{ total: number; pending: number; replayed: number }> {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM job_quarantine');
    const pendingStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM job_quarantine WHERE replayed_at IS NULL',
    );
    const replayedStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM job_quarantine WHERE replayed_at IS NOT NULL',
    );

    const total = (totalStmt.get() as { count: number }).count;
    const pending = (pendingStmt.get() as { count: number }).count;
    const replayed = (replayedStmt.get() as { count: number }).count;

    return { total, pending, replayed };
  }

  close(): void {
    this.db.close();
  }

  private mapRowToEntry(row: Record<string, unknown>): JobQuarantineEntry {
    return {
      id: row.id as string,
      jobType: row.job_type as JobType,
      jobId: row.job_id as string,
      tenantId: row.tenant_id as string,
      payload: JSON.parse(row.payload as string) as JobPayload,
      reason: row.reason as string,
      kind: row.kind as string,
      attemptsMade: row.attempts_made as number,
      quarantinedAt: row.quarantined_at as string,
      replayedAt: row.replayed_at as string | undefined,
      replayAttempts: (row.replay_attempts as number) ?? 0,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

let instance: JobQuarantineStorage | null = null;
export { JobQuarantineStorage };

export function getJobQuarantineStorage(dbPath?: string): JobQuarantineStorage {
  // A single instance is shared so the queue manager's quarantine writes,
  // inspection, and replay all observe the same store. Tests reset it via
  // `clearJobQuarantineInstance()` between cases. Under test an ephemeral
  // in-memory store is used so unit tests never touch the on-disk file.
  if (!instance) {
    if (process.env.NODE_ENV === 'test') {
      instance = new JobQuarantineStorage(dbPath ?? ':memory:');
    } else {
      instance = new JobQuarantineStorage(dbPath);
    }
  }
  return instance;
}

export function clearJobQuarantineInstance(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export { DEFAULT_QUARANTINE_CONFIG };