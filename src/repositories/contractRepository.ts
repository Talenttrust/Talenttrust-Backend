import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Contract, ContractStatus } from "../db/types";
import {
  encodeCursor,
  decodeCursor,
  parseLimit,
} from "../contracts/cursor.repository";
import type {
  CursorPage,
  CursorPaginationInput,
} from "../contracts/cursor.types";
import { VersionConflictError, NotFoundError } from "../errors/appError";
import {
  isSoftDeleted,
  isPastRetentionWindow,
  filterNotDeleted,
  SoftDeleteRetentionError,
  DEFAULT_SOFT_DELETE_RETENTION_DAYS,
} from "../utils/softDelete";

/** Input shape for creating a new contract. */
export interface CreateContractInput {
  title: string;
  clientId: string;
  freelancerId?: string;
  amount: number;
  status?: ContractStatus;
}

/** Canonical set of valid contract statuses (mirrors the DB CHECK constraint). */
const VALID_CONTRACT_STATUSES: readonly ContractStatus[] = [
  "draft",
  "active",
  "completed",
  "disputed",
  "cancelled",
];

/**
 * Reject any status outside the allowed set before it reaches the database.
 * The `contracts.status` column carries a matching CHECK constraint, but some
 * SQLite builds (notably the one bundled on CI) do not enforce CHECK on every
 * write path, so we validate in code to keep the behavior deterministic across
 * platforms.
 */
function assertValidContractStatus(status: ContractStatus): void {
  if (!VALID_CONTRACT_STATUSES.includes(status)) {
    throw new Error(`Invalid contract status: ${String(status)}`);
  }
}

/**
 * Repository interface for contracts data access layer.
 *
 * All methods are async to allow swapping between synchronous SQLite and
 * asynchronous backends without changing callers.
 */
export interface IContractRepository {
  create(data: CreateContractInput): Promise<Contract>;
  findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Contract | undefined>;
  findAll(options?: { includeDeleted?: boolean }): Promise<Contract[]>;
  findByClientId(
    clientId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Contract[]>;
  findPage(
    input?: CursorPaginationInput & { includeDeleted?: boolean },
  ): Promise<CursorPage<Contract>>;
  updateWithVersion(
    id: string,
    fields: Partial<Omit<Contract, "id" | "createdAt" | "version">>,
    expectedVersion: number,
  ): Promise<Contract>;
  delete(id: string, now?: Date): Promise<boolean>;
  restore(id: string, now?: Date, retentionDays?: number): Promise<Contract>;
  purgeExpired(now?: Date, retentionDays?: number): Promise<number>;
}

/** Row shape as returned from SQLite (snake_case columns). */
interface ContractRow {
  id: string;
  title: string;
  client_id: string;
  freelancer_id: string;
  amount: number;
  status: string;
  version: number;
  created_at: string;
  deleted_at?: string | null;
}

/** Maps a raw DB row to the domain Contract interface. */
function toContract(row: ContractRow): Contract {
  return {
    id: row.id,
    title: row.title,
    clientId: row.client_id,
    freelancerId: row.freelancer_id,
    amount: row.amount,
    status: row.status as ContractStatus,
    version: row.version,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

/**
 * SQLite-backed repository providing typed CRUD access to the `contracts` table.
 *
 * Instantiate with an open `Database` instance. Each method prepares its
 * statement lazily on first call and caches it for subsequent calls.
 */
export class ContractRepository implements IContractRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async findAll(options?: { includeDeleted?: boolean }): Promise<Contract[]> {
    const sql = options?.includeDeleted
      ? "SELECT * FROM contracts ORDER BY created_at DESC"
      : "SELECT * FROM contracts WHERE deleted_at IS NULL ORDER BY created_at DESC";
    const rows = this.db.prepare<[], ContractRow>(sql).all();
    return rows.map(toContract);
  }

  async findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Contract | undefined> {
    const sql = options?.includeDeleted
      ? "SELECT * FROM contracts WHERE id = ?"
      : "SELECT * FROM contracts WHERE id = ? AND deleted_at IS NULL";
    const row = this.db.prepare<[string], ContractRow>(sql).get(id);
    return row ? toContract(row) : undefined;
  }

  async findByClientId(
    clientId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Contract[]> {
    const sql = options?.includeDeleted
      ? "SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at DESC"
      : "SELECT * FROM contracts WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC";
    const rows = this.db.prepare<[string], ContractRow>(sql).all(clientId);
    return rows.map(toContract);
  }

  async create(data: CreateContractInput): Promise<Contract> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const status: ContractStatus = data.status ?? "draft";
    assertValidContractStatus(status);

    this.db
      .prepare<
        [string, string, string, string, number, string, number, string]
      >(
        `INSERT INTO contracts
           (id, title, client_id, freelancer_id, amount, status, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.title,
        data.clientId,
        data.freelancerId ?? "",
        data.amount,
        status,
        0,
        createdAt,
      );

    return {
      id,
      title: data.title,
      clientId: data.clientId,
      freelancerId: data.freelancerId ?? "",
      amount: data.amount,
      status,
      createdAt,
      version: 0,
      deletedAt: null,
    };
  }

  async updateWithVersion(
    id: string,
    fields: Partial<Omit<Contract, "id" | "createdAt" | "version">>,
    expectedVersion: number,
  ): Promise<Contract> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError(`Contract with id ${id} not found`);
    }

    const result = this.db
      .prepare<
        [
          string | null,
          string | null,
          number | null,
          string | null,
          string,
          number,
        ]
      >(
        `UPDATE contracts
         SET title         = COALESCE(?, title),
             status        = COALESCE(?, status),
             amount        = COALESCE(?, amount),
             freelancer_id = COALESCE(?, freelancer_id),
             version       = version + 1
         WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      )
      .run(
        fields.title ?? null,
        fields.status ?? null,
        fields.amount ?? null,
        fields.freelancerId ?? null,
        id,
        expectedVersion,
      );

    if (result.changes === 0) {
      throw new VersionConflictError();
    }

    return (await this.findById(id))!;
  }

  async delete(id: string, now: Date = new Date()): Promise<boolean> {
    const result = this.db
      .prepare<[string, string]>(
        "UPDATE contracts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now.toISOString(), id);
    return result.changes > 0;
  }

  async restore(
    id: string,
    now: Date = new Date(),
    retentionDays: number = DEFAULT_SOFT_DELETE_RETENTION_DAYS,
  ): Promise<Contract> {
    const existing = await this.findById(id, { includeDeleted: true });
    if (!existing) {
      throw new NotFoundError(`Contract with id ${id} not found`);
    }
    if (!isSoftDeleted(existing.deletedAt)) {
      throw new Error(`Contract ${id} is not soft-deleted`);
    }
    if (isPastRetentionWindow(existing.deletedAt!, retentionDays, now)) {
      throw new SoftDeleteRetentionError(
        `Contract ${id} retention window of ${retentionDays} days has expired`,
      );
    }

    this.db
      .prepare<[string]>("UPDATE contracts SET deleted_at = NULL WHERE id = ?")
      .run(id);

    return (await this.findById(id, { includeDeleted: true }))!;
  }

  async purgeExpired(
    now: Date = new Date(),
    retentionDays: number = DEFAULT_SOFT_DELETE_RETENTION_DAYS,
  ): Promise<number> {
    const cutoffIso = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare<[string]>(
        "DELETE FROM contracts WHERE deleted_at IS NOT NULL AND deleted_at <= ?",
      )
      .run(cutoffIso);
    return result.changes;
  }

  async findPage(
    input: CursorPaginationInput & { includeDeleted?: boolean } = {},
  ): Promise<CursorPage<Contract>> {
    const limit = parseLimit(input.limit);
    const includeDeleted = input.includeDeleted ?? false;

    let rows: ContractRow[];

    if (input.cursor) {
      const pos = decodeCursor(input.cursor);
      const sql = includeDeleted
        ? `SELECT * FROM contracts
           WHERE (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        : `SELECT * FROM contracts
           WHERE (created_at < ? OR (created_at = ? AND id < ?)) AND deleted_at IS NULL
           ORDER BY created_at DESC, id DESC
           LIMIT ?`;

      rows = this.db
        .prepare<[string, string, string, number], ContractRow>(sql)
        .all(pos.createdAt, pos.createdAt, pos.id, limit + 1);
    } else {
      const sql = includeDeleted
        ? `SELECT * FROM contracts
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        : `SELECT * FROM contracts
           WHERE deleted_at IS NULL
           ORDER BY created_at DESC, id DESC
           LIMIT ?`;

      rows = this.db.prepare<[number], ContractRow>(sql).all(limit + 1);
    }

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const data = pageRows.map(toContract);

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.id })
        : null;

    return { data, nextCursor, hasNextPage, limit };
  }
}

/**
 * In-memory implementation of IContractRepository for deterministic tests and local development.
 */
export class InMemoryContractRepository implements IContractRepository {
  private contracts: Map<string, Contract> = new Map();
  /** Monotonic insertion counter used as a deterministic tie-breaker when two
   * contracts share an identical `createdAt` timestamp. */
  private insertionSeq = 0;
  private readonly insertionOrder: Map<string, number> = new Map();

  async create(data: CreateContractInput): Promise<Contract> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const status: ContractStatus = data.status ?? "draft";
    assertValidContractStatus(status);

    const contract: Contract = {
      id,
      title: data.title,
      clientId: data.clientId,
      freelancerId: data.freelancerId ?? "",
      amount: data.amount,
      status,
      createdAt,
      version: 0,
      deletedAt: null,
    };

    this.contracts.set(id, contract);
    this.insertionOrder.set(id, this.insertionSeq++);
    return contract;
  }

  async findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Contract | undefined> {
    const record = this.contracts.get(id);
    if (!record) return undefined;
    if (!options?.includeDeleted && isSoftDeleted(record.deletedAt)) {
      return undefined;
    }
    return record;
  }

  async findAll(options?: { includeDeleted?: boolean }): Promise<Contract[]> {
    const all = Array.from(this.contracts.values()).sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      return (
        (this.insertionOrder.get(b.id) ?? 0) -
        (this.insertionOrder.get(a.id) ?? 0)
      );
    });
    return options?.includeDeleted ? all : filterNotDeleted(all);
  }

  async findByClientId(
    clientId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Contract[]> {
    const all = Array.from(this.contracts.values()).filter(
      (c) => c.clientId === clientId,
    );
    return options?.includeDeleted ? all : filterNotDeleted(all);
  }

  async findPage(
    input: CursorPaginationInput & { includeDeleted?: boolean } = {},
  ): Promise<CursorPage<Contract>> {
    const limit = parseLimit(input.limit);
    let sorted = await this.findAll({ includeDeleted: input.includeDeleted });

    if (input.cursor) {
      const pos = decodeCursor(input.cursor);
      sorted = sorted.filter(
        (c) =>
          c.createdAt < pos.createdAt ||
          (c.createdAt === pos.createdAt && c.id < pos.id),
      );
    }

    const data = sorted.slice(0, limit);
    const hasNextPage = sorted.length > limit;
    const lastRow = data[data.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? encodeCursor({ createdAt: lastRow.createdAt, id: lastRow.id })
        : null;

    return { data, nextCursor, hasNextPage, limit };
  }

  async updateWithVersion(
    id: string,
    fields: Partial<Omit<Contract, "id" | "createdAt" | "version">>,
    expectedVersion: number,
  ): Promise<Contract> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError(`Contract with id ${id} not found`);
    }

    if (existing.version !== expectedVersion) {
      throw new VersionConflictError();
    }

    const updated: Contract = {
      ...existing,
      ...fields,
      version: existing.version + 1,
    };

    this.contracts.set(id, updated);
    return updated;
  }

  async delete(id: string, now: Date = new Date()): Promise<boolean> {
    const record = this.contracts.get(id);
    if (!record || isSoftDeleted(record.deletedAt)) {
      return false;
    }
    record.deletedAt = now.toISOString();
    return true;
  }

  async restore(
    id: string,
    now: Date = new Date(),
    retentionDays: number = DEFAULT_SOFT_DELETE_RETENTION_DAYS,
  ): Promise<Contract> {
    const record = this.contracts.get(id);
    if (!record) {
      throw new NotFoundError(`Contract with id ${id} not found`);
    }
    if (!isSoftDeleted(record.deletedAt)) {
      throw new Error(`Contract ${id} is not soft-deleted`);
    }
    if (isPastRetentionWindow(record.deletedAt!, retentionDays, now)) {
      throw new SoftDeleteRetentionError(
        `Contract ${id} retention window of ${retentionDays} days has expired`,
      );
    }

    record.deletedAt = null;
    return { ...record };
  }

  async purgeExpired(
    now: Date = new Date(),
    retentionDays: number = DEFAULT_SOFT_DELETE_RETENTION_DAYS,
  ): Promise<number> {
    let purged = 0;
    for (const [id, record] of this.contracts.entries()) {
      if (
        isSoftDeleted(record.deletedAt) &&
        record.deletedAt &&
        isPastRetentionWindow(record.deletedAt, retentionDays, now)
      ) {
        this.contracts.delete(id);
        this.insertionOrder.delete(id);
        purged++;
      }
    }
    return purged;
  }

  clear(): void {
    this.contracts.clear();
    this.insertionOrder.clear();
    this.insertionSeq = 0;
  }
}
