import { EscrowContract, HttpError } from '../domain';
import { ContractFilter, EscrowRepository, ReputationDelta, reputation } from './types';
import { TransactionalRepository } from './transaction';

export class MemoryRepository extends TransactionalRepository implements EscrowRepository {
  readonly driver = 'memory';
  private state = { contracts: new Map<number, EscrowContract>(), reputation: new Map<string, ReputationDelta>(), id: 0 };
  private snapshot?: typeof this.state;

  protected begin() { this.snapshot = structuredClone(this.state); }
  protected commit() { this.snapshot = undefined; }
  protected rollback() { this.state = this.snapshot!; this.snapshot = undefined; }
  protected dispose() {}

  nextId() { return this.access(() => ++this.state.id); }
  get(id: number) { return this.access(() => structuredClone(this.state.contracts.get(id))); }
  list(filter: ContractFilter = {}) {
    return this.access(() => structuredClone([...this.state.contracts.values()]
      .filter(c => (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party))
      .sort((a, b) => a.id - b.id)));
  }
  insert(c: EscrowContract) {
    return this.access(() => {
      if (this.state.contracts.has(c.id)) throw new HttpError(409, 'duplicate_contract', 'Contract already exists');
      this.state.contracts.set(c.id, structuredClone(c));
      this.state.id = Math.max(this.state.id, c.id);
    });
  }
  update(c: EscrowContract, expectedUpdatedAt: string) {
    return this.access(() => {
      if (this.state.contracts.get(c.id)?.updatedAt !== expectedUpdatedAt) {
        throw new HttpError(409, 'write_conflict', 'Contract changed; reload before retrying');
      }
      this.state.contracts.set(c.id, structuredClone(c));
    });
  }
  getReputation(address: string) {
    return this.access(() => reputation(address, this.state.reputation.get(address) ?? { completedContracts: 0, totalRating: 0 }));
  }
  upsertReputation(address: string, delta: ReputationDelta) {
    return this.access(() => {
      const previous = this.state.reputation.get(address) ?? { completedContracts: 0, totalRating: 0 };
      this.state.reputation.set(address, { completedContracts: previous.completedContracts + delta.completedContracts,
        totalRating: previous.totalRating + delta.totalRating });
    });
  }
}
