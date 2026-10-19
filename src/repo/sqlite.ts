import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EscrowContract, HttpError } from '../domain';
import { ContractFilter, EscrowRepository, ReputationDelta, reputation } from './types';
import { TransactionalRepository } from './transaction';
import { migrate } from './migrations';

export class SqliteRepository extends TransactionalRepository implements EscrowRepository {
  readonly driver = 'sqlite';
  private db: Database.Database;

  constructor(path = './data/talenttrust.db') {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma('journal_mode = WAL');
      migrate(this.db);
      // Waiting synchronously for another connection would block its async commit.
      this.db.pragma('busy_timeout = 0');
    } catch (error) { this.db.close(); throw error; }
  }

  protected async begin() {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { this.db.exec('BEGIN IMMEDIATE'); return; }
      catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
  }
  protected commit() { this.db.exec('COMMIT'); }
  protected rollback() { if (this.db.inTransaction) this.db.exec('ROLLBACK'); }
  protected dispose() { this.db.close(); }

  nextId() {
    return this.access(() => (this.db.prepare('UPDATE id_sequence SET value = value + 1 WHERE singleton = 1 RETURNING value').get() as { value: number }).value);
  }
  get(id: number) {
    return this.access(() => {
      const row = this.db.prepare('SELECT data FROM contracts WHERE id = ?').get(id) as { data: string } | undefined;
      return row ? JSON.parse(row.data) as EscrowContract : undefined;
    });
  }
  list(filter: ContractFilter = {}) {
    return this.access(() => {
      const rows = this.db.prepare(`SELECT data FROM contracts
        WHERE (? IS NULL OR status = ?) AND (? IS NULL OR client = ? OR freelancer = ?) ORDER BY id`)
        .all(filter.status || null, filter.status || null, filter.party || null, filter.party || null, filter.party || null) as { data: string }[];
      return rows.map(row => JSON.parse(row.data) as EscrowContract);
    });
  }
  insert(c: EscrowContract) {
    return this.access(() => {
      if (this.db.prepare('SELECT id FROM contracts WHERE id = ?').get(c.id)) {
        throw new HttpError(409, 'duplicate_contract', 'Contract already exists');
      }
      this.db.prepare('INSERT INTO contracts (id, status, client, freelancer, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.id, c.status, c.client, c.freelancer, c.createdAt, c.updatedAt, JSON.stringify(c));
      this.db.prepare('UPDATE id_sequence SET value = MAX(value, ?) WHERE singleton = 1').run(c.id);
    });
  }
  update(c: EscrowContract, expectedUpdatedAt: string) {
    return this.access(() => {
      const result = this.db.prepare(`UPDATE contracts SET status = ?, client = ?, freelancer = ?, created_at = ?, updated_at = ?, data = ?
        WHERE id = ? AND updated_at = ?`)
        .run(c.status, c.client, c.freelancer, c.createdAt, c.updatedAt, JSON.stringify(c), c.id, expectedUpdatedAt);
      if (!result.changes) throw new HttpError(409, 'write_conflict', 'Contract changed; reload before retrying');
    });
  }
  getReputation(address: string) {
    return this.access(() => {
      const row = this.db.prepare('SELECT completed AS completedContracts, total AS totalRating FROM reputation WHERE address = ?')
        .get(address) as ReputationDelta | undefined;
      return reputation(address, row ?? { completedContracts: 0, totalRating: 0 });
    });
  }
  upsertReputation(address: string, delta: ReputationDelta) {
    return this.access(() => {
      this.db.prepare(`INSERT INTO reputation (address, completed, total) VALUES (?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET completed = completed + excluded.completed, total = total + excluded.total`)
        .run(address, delta.completedContracts, delta.totalRating);
    });
  }
}
