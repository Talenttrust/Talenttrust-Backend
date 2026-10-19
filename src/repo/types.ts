import { EscrowContract, Reputation } from '../domain';

export type StorageDriver = 'memory' | 'sqlite';
export interface ContractFilter { status?: string; party?: string }
export type ReputationDelta = Pick<Reputation, 'completedContracts' | 'totalRating'>;

/** Reads return detached values. Transactions include IDs and reputation writes.
 * Nested transactions join their parent; any nested failure aborts the parent.
 * Await all repository operations before returning from a transaction callback.
 */
export interface EscrowRepository {
  readonly driver: StorageDriver;
  nextId(): Promise<number>;
  get(id: number): Promise<EscrowContract | undefined>;
  insert(contract: EscrowContract): Promise<void>;
  update(contract: EscrowContract, expectedUpdatedAt: string): Promise<void>;
  list(filter?: ContractFilter): Promise<EscrowContract[]>;
  getReputation(address: string): Promise<Reputation>;
  upsertReputation(address: string, delta: ReputationDelta): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function reputation(address: string, delta: ReputationDelta): Reputation {
  return { address, ...delta, averageRating: delta.completedContracts
    ? Math.round(delta.totalRating / delta.completedContracts * 100) / 100 : 0 };
}
