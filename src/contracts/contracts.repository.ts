import { Tracer } from '../tracing/tracer';

export interface ContractRecord {
  id: string;
  status: 'active' | 'draft';
}

export interface ContractRepository {
  listContracts(): Promise<ContractRecord[]>;
}

export class InMemoryContractRepository implements ContractRepository {
  constructor(private readonly tracer: Tracer) {}

  async listContracts(): Promise<ContractRecord[]> {
    const span = this.tracer.startSpan('contracts.repository.list', 'db', {
      'db.system': 'memory',
      'db.operation': 'select',
      'db.collection': 'contracts',
    });

    try {
      return [];
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
