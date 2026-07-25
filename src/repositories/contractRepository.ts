import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Contract, ContractStatus } from "../db/types";
import {
  encodeCursor,
  decodeCursor,
  parseLimit,
} from "../contracts/cursor.repository";
import type { CursorPage, CursorPaginationInput } from "../contracts/cursor.types";
import { VersionConflictError, NotFoundError } from "../errors/appError";

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
  findById(id: string): Promise<Contract | undefined>;
  findAll(): Promise<Contract[]>;
  findByClientId(clientId: string): Promise<Contract[]>;
  findPage(input: CursorPaginationInput): Promise<CursorPage<Contract>>;
  updateWithVersion(
    id: string,
    fields: Partial<Omit<Contract, "id" | "createdAt" | "version">>,
    expectedVersion: number,
  ): Promise<Contract>;
  delete(id: string): Promise<boolean>;
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

  async findAll(): Promise<Contract[]> {
    const rows = this.db
      .prepare<[], ContractRow>("SELECT * FROM contracts ORDER BY created_at DESC")
      .all();
    return rows.map(toContract);
  }

  async findById(id: string): Promise<Contract | undefined> {
    const row = this.db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE id = ?")
      .get(id);
    return row ? toContract(row) : undefined;
  }

  async findByClientId(clientId: string): Promise<Contract[]> {
    const rows = this.db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at DESC")
      .all(clientId);
    return rows.map(toContract);
  }

  async create(data: CreateContractInput): Promise<Contract> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const status: ContractStatus = data.status ?? "draft";
    assertValidContractStatus(status);

    this.db
      .prepare<[string, string, string, string, number, string, number, string]>(
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
      .prepare<[string | null, string | null, number | null, string | null, string, number]>(
        `UPDATE contracts
         SET title         = COALESCE(?, title),
             status        = COALESCE(?, status),
             amount        = COALESCE(?, amount),
             freelancer_id = COALESCE(?, freelancer_id),
             version       = version + 1
         WHERE id = ? AND version = ?`,
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

  async delete(id: string): Promise<boolean> {
    const result = this.db
      .prepare<[string]>("DELETE FROM contracts WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  async findPage(input: CursorPaginationInput = {}): Promise<CursorPage<Contract>> {
    const limit = parseLimit(input.limit);

    let rows: ContractRow[];

    if (input.cursor) {
      const pos = decodeCursor(input.cursor);

      rows = this.db
        .prepare<[string, string, string, number], ContractRow>(
          `SELECT * FROM contracts
           WHERE (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(pos.createdAt, pos.createdAt, pos.id, limit + 1);
    } else {
      rows = this.db
        .prepare<[number], ContractRow>(
          `SELECT * FROM contracts
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit + 1);
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
    };

    this.contracts.set(id, contract);
    this.insertionOrder.set(id, this.insertionSeq++);
    return contract;
  }

  async findById(id: string): Promise<Contract | undefined> {
    return this.contracts.get(id);
  }

  async findAll(): Promise<Contract[]> {
    return Array.from(this.contracts.values()).sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      // Deterministic, insertion-order tie-break (most recently inserted first)
      // so equal-timestamp contracts sort stably instead of by random UUID.
      return (this.insertionOrder.get(b.id) ?? 0) - (this.insertionOrder.get(a.id) ?? 0);
    });
  }

  async findByClientId(clientId: string): Promise<Contract[]> {
    return Array.from(this.contracts.values()).filter((c) => c.clientId === clientId);
  }

  async findPage(input: CursorPaginationInput = {}): Promise<CursorPage<Contract>> {
    const limit = parseLimit(input.limit);
    let sorted = await this.findAll();

    if (input.cursor) {
      const pos = decodeCursor(input.cursor);
      sorted = sorted.filter(
        (c) => c.createdAt < pos.createdAt || (c.createdAt === pos.createdAt && c.id < pos.id),
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
    const existing = this.contracts.get(id);
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

  async delete(id: string): Promise<boolean> {
    return this.contracts.delete(id);
  }

  clear(): void {
    this.contracts.clear();
  }
}
