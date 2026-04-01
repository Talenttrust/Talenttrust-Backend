/**
 * ContractRepository — CRUD operations for the `contracts` table.
 *
 * All queries use prepared statements (parameter binding) to prevent SQL
 * injection.  The repository layer is intentionally ignorant of HTTP/Express
 * concerns; it operates purely on domain types defined in ../db/types.ts.
 *
 * Threat model:
 *  - IDs are caller-supplied UUIDs; validated upstream in route handlers.
 *  - Amount is stored as an integer (stroops) to avoid floating-point drift.
 *  - Status transitions are constrained by a DB CHECK constraint as a second
 *    line of defence beyond application-level validation.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Contract, ContractStatus } from "../db/types";

/** Row shape as returned from SQLite (snake_case columns). */
interface ContractRow {
  id: string;
  title: string;
  client_id: string;
  freelancer_id: string;
  amount: number;
  status: string;
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
    createdAt: row.created_at,
  };
}

/**
 * Repository providing typed CRUD access to the `contracts` table.
 *
 * Instantiate with an open `Database` instance.  Each method prepares its
 * statement lazily on first call and caches it for subsequent calls.
 */
export class ContractRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Returns every contract ordered by creation date descending.
   *
   * @returns Array of Contract objects (empty array when none exist).
   */
  findAll(): Contract[] {
    const rows = this.db
      .prepare<
        [],
        ContractRow
      >("SELECT * FROM contracts ORDER BY created_at DESC")
      .all();
    return rows.map(toContract);
  }

  /**
   * Finds a single contract by its UUID primary key.
   *
   * @param id - The contract UUID.
   * @returns The matching Contract or `undefined` if not found.
   */
  findById(id: string): Contract | undefined {
    const row = this.db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE id = ?")
      .get(id);
    return row ? toContract(row) : undefined;
  }

  /**
   * Retrieves all contracts associated with a given client user.
   *
   * @param clientId - UUID of the client user.
   */
  findByClientId(clientId: string): Contract[] {
    const rows = this.db
      .prepare<
        [string],
        ContractRow
      >("SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at DESC")
      .all(clientId);
    return rows.map(toContract);
  }

  /**
   * Creates a new contract record.
   *
   * Generates a UUID and records the current timestamp automatically.
   *
   * @param data - Required contract fields (id and createdAt are generated).
   * @returns The newly created Contract.
   */
  create(
    data: Omit<Contract, "id" | "createdAt" | "status"> & {
      status?: ContractStatus;
    },
  ): Contract {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const status: ContractStatus = data.status ?? "draft";

    this.db
      .prepare<[string, string, string, string, number, string, string]>(
        `INSERT INTO contracts
           (id, title, client_id, freelancer_id, amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.title,
        data.clientId,
        data.freelancerId,
        data.amount,
        status,
        createdAt,
      );

    return { id, ...data, status, createdAt };
  }

  /**
   * Updates the status of an existing contract.
   *
   * @param id     - UUID of the contract to update.
   * @param status - New status value (must satisfy the ContractStatus union).
   * @returns The updated Contract, or `undefined` if the ID was not found.
   */
  updateStatus(id: string, status: ContractStatus): Contract | undefined {
    this.db
      .prepare<[string, string]>("UPDATE contracts SET status = ? WHERE id = ?")
      .run(status, id);
    return this.findById(id);
  }

  /**
   * Deletes a contract by ID.
   *
   * @param id - UUID of the contract to remove.
   * @returns `true` if a row was deleted, `false` if the ID did not exist.
   */
  delete(id: string): boolean {
    const result = this.db
      .prepare<[string]>("DELETE FROM contracts WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
