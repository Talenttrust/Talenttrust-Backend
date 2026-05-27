import { v4 as uuidv4 } from 'uuid';
import { CreateContractDto, UpdateContractDto, ContractQueryParams } from '../modules/contracts/dto/contract.dto';
import { Contract, ContractStatus } from '../db/types';

export interface ContractMilestoneResponse {
  title: string;
  description: string;
  amount: number;
  deadline: string | null;
  completed: boolean;
}

export interface ContractResponse extends Contract {
  milestones: ContractMilestoneResponse[] | null;
  updatedAt: string;
}

export interface ContractListResponse {
  contracts: ContractResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Repository interface for contracts data access layer.
 */
export interface ContractsRepository {
  create(contractData: CreateContractDto): Promise<ContractResponse>;
  findById(id: string): Promise<ContractResponse | undefined>;
  findAll(): Promise<ContractResponse[]>;
  findMany(params: ContractQueryParams): Promise<ContractListResponse>;
  update(id: string, updateData: UpdateContractDto): Promise<ContractResponse>;
  updateWithVersion(id: string, fields: Partial<Contract>, expectedVersion: number): Promise<ContractResponse>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  count(filters?: Partial<ContractQueryParams>): Promise<number>;
}

export interface ContractEntity extends Contract {
  description: string;
  deadline: string | null;
  terms: string | null;
  milestones: ContractMilestoneResponse[] | null;
  updatedAt: string;
}

/**
 * In-memory implementation of ContractsRepository for development and testing.
 */
export class InMemoryContractsRepository implements ContractsRepository {
  private contracts: Map<string, ContractEntity> = new Map();

  async create(contractData: CreateContractDto): Promise<ContractResponse> {
    const id = uuidv4();
    const now = new Date().toISOString();
    
    const contract: ContractEntity = {
      id,
      title: contractData.title,
      description: contractData.description,
      freelancerId: contractData.freelancerId || '',
      clientId: contractData.clientId,
      amount: contractData.budget,
      deadline: contractData.deadline || null,
      status: (contractData.status as ContractStatus) || 'draft',
      terms: contractData.terms || null,
      milestones: contractData.milestones ? contractData.milestones.map(m => ({
        title: m.title,
        description: m.description,
        amount: m.amount,
        deadline: m.deadline || null,
        completed: m.completed || false
      })) : null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };

    this.contracts.set(id, contract);
    return this.mapToResponse(contract);
  }

  async findById(id: string): Promise<ContractResponse | undefined> {
    const contract = this.contracts.get(id);
    return contract ? this.mapToResponse(contract) : undefined;
  }

  async findAll(): Promise<ContractResponse[]> {
    return Array.from(this.contracts.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(c => this.mapToResponse(c));
  }

  async findMany(params: ContractQueryParams): Promise<ContractListResponse> {
    let contracts = Array.from(this.contracts.values());

    if (params.status) {
      contracts = contracts.filter(c => c.status === params.status);
    }
    if (params.clientId) {
      contracts = contracts.filter(c => c.clientId === params.clientId);
    }
    if (params.freelancerId) {
      contracts = contracts.filter(c => c.freelancerId === params.freelancerId);
    }

    const total = contracts.length;
    const totalPages = Math.ceil(total / params.limit);
    const startIndex = (params.page - 1) * params.limit;
    const paginatedContracts = contracts.slice(startIndex, startIndex + params.limit);

    return {
      contracts: paginatedContracts.map(c => this.mapToResponse(c)),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages,
      },
    };
  }

  async update(id: string, updateData: UpdateContractDto): Promise<ContractResponse> {
    const existingContract = this.contracts.get(id);
    if (!existingContract) {
      throw new Error(`Contract with id ${id} not found`);
    }

    const { budget, ...rest } = updateData;
    const updatedContract: ContractEntity = {
      ...existingContract,
      ...rest,
      amount: budget ?? existingContract.amount,
      updatedAt: new Date().toISOString(),
    } as ContractEntity;

    this.contracts.set(id, updatedContract);
    return this.mapToResponse(updatedContract);
  }

  async updateWithVersion(
    id: string,
    fields: Partial<Contract>,
    expectedVersion: number
  ): Promise<ContractResponse> {
    const existing = this.contracts.get(id);
    if (!existing) {
      throw new Error(`Contract with id ${id} not found`);
    }

    if (existing.version !== expectedVersion) {
      throw new Error('Version conflict');
    }

    const updated: ContractEntity = {
      ...existing,
      ...fields,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.contracts.set(id, updated);
    return this.mapToResponse(updated);
  }

  async delete(id: string): Promise<boolean> {
    const exists = this.contracts.has(id);
    if (exists) {
      this.contracts.delete(id);
    }
    return exists;
  }

  async exists(id: string): Promise<boolean> {
    return this.contracts.has(id);
  }

  async count(filters?: Partial<ContractQueryParams>): Promise<number> {
    let contracts = Array.from(this.contracts.values());
    if (filters) {
      if (filters.status) contracts = contracts.filter(c => c.status === filters.status);
      if (filters.clientId) contracts = contracts.filter(c => c.clientId === filters.clientId);
      if (filters.freelancerId) contracts = contracts.filter(c => c.freelancerId === filters.freelancerId);
    }
    return contracts.length;
  }

  private mapToResponse(contract: ContractEntity): ContractResponse {
    return { ...contract };
  }

  clear(): void {
    this.contracts.clear();
  }

  getAll(): ContractResponse[] {
    return Array.from(this.contracts.values()).map(c => this.mapToResponse(c));
  }
}
