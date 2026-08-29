import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import crypto from 'crypto';
import { WebhookSubscription, CreateWebhookSubscriptionDto, UpdateWebhookSubscriptionDto } from '../types/webhook.types';
import type { CursorPaginationInput, CursorPage } from '../contracts/cursor.types';
import { encodeCursor, decodeCursor, parseLimit } from '../contracts/cursor.repository';

export interface WebhookSubscriptionRepository {
  create(dto: CreateWebhookSubscriptionDto): Promise<WebhookSubscription>;
  findById(id: string): Promise<WebhookSubscription | undefined>;
  findAll(filter?: { consumerId?: string; eventType?: string; active?: boolean }): Promise<WebhookSubscription[]>;
  findAllPaginated(
    filter: { consumerId?: string; eventType?: string; active?: boolean },
    input: CursorPaginationInput,
  ): Promise<CursorPage<WebhookSubscription>>;
  update(id: string, dto: UpdateWebhookSubscriptionDto): Promise<WebhookSubscription>;
  delete(id: string): Promise<boolean>;
}

/** Simple SQLite-backed repository */
export class SqliteWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  async create(dto: CreateWebhookSubscriptionDto): Promise<WebhookSubscription> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO webhook_subscriptions (id, consumer_id, url, event_type, secret, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, dto.consumerId ?? null, dto.url, dto.eventType, dto.secret ?? null, now, now);
    return this.findById(id) as Promise<WebhookSubscription>;
  }

  async findById(id: string): Promise<WebhookSubscription | undefined> {
    const row = this.db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : undefined;
  }

  async findAll(filter?: { consumerId?: string; eventType?: string; active?: boolean }): Promise<WebhookSubscription[]> {
    let sql = 'SELECT * FROM webhook_subscriptions';
    const conditions: string[] = [];
    const params: any[] = [];
    if (filter?.consumerId) {
      conditions.push('consumer_id = ?');
      params.push(filter.consumerId);
    }
    if (filter?.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter?.active !== undefined) {
      conditions.push('active = ?');
      params.push(filter.active ? 1 : 0);
    }
    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(this.mapRow);
  }

  async findAllPaginated(
    filter: { consumerId?: string; eventType?: string; active?: boolean },
    input: CursorPaginationInput,
  ): Promise<CursorPage<WebhookSubscription>> {
    const limit = parseLimit(input.limit);

    let sql = 'SELECT * FROM webhook_subscriptions';
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.consumerId) {
      conditions.push('consumer_id = ?');
      params.push(filter.consumerId);
    }
    if (filter?.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter?.active !== undefined) {
      conditions.push('active = ?');
      params.push(filter.active ? 1 : 0);
    }

    if (input.cursor) {
      const pos = decodeCursor(input.cursor);
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(pos.createdAt, pos.createdAt, pos.id);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as any[];
    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const data = pageRows.map(this.mapRow);

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.id })
        : null;

    return { data, nextCursor, hasNextPage, limit };
  }

  async update(id: string, dto: UpdateWebhookSubscriptionDto): Promise<WebhookSubscription> {
    const updates: string[] = [];
    const params: any[] = [];
    if (dto.url !== undefined) { updates.push('url = ?'); params.push(dto.url); }
    if (dto.eventType !== undefined) { updates.push('event_type = ?'); params.push(dto.eventType); }
    if (dto.secret !== undefined) { updates.push('secret = ?'); params.push(dto.secret); }
    if (dto.active !== undefined) { updates.push('active = ?'); params.push(dto.active ? 1 : 0); }
    updates.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    const sql = `UPDATE webhook_subscriptions SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...params);
    return this.findById(id) as Promise<WebhookSubscription>;
  }

  async delete(id: string): Promise<boolean> {
    const info = this.db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  private mapRow(row: any): WebhookSubscription {
    return {
      id: row.id,
      consumerId: row.consumer_id ?? undefined,
      url: row.url,
      eventType: row.event_type,
      secret: row.secret ?? undefined,
      active: !!row.active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
