import * as fs from 'fs/promises';
import * as path from 'path';
import { Database, ContractMetadata, Contract, User, ApiKey } from './schema';

const DB_PATH = path.join(__dirname, '../../data/database.json');

class DatabaseService {
  private db: Database | null = null;

  private async ensureDataDir(): Promise<void> {
    const dataDir = path.dirname(DB_PATH);
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
    }
  }

  private async loadDatabase(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    await this.ensureDataDir();

    try {
      const data = await fs.readFile(DB_PATH, 'utf-8');
      this.db = JSON.parse(data) as Database;
    } catch {
      // Initialize with empty database
      this.db = {
        contract_metadata: [],
        contracts: [],
        users: [],
      api_keys: []
      };
      await this.saveDatabase();
    }

    return this.db;
  }

  private async saveDatabase(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not loaded');
    }
    await this.ensureDataDir();
    await fs.writeFile(DB_PATH, JSON.stringify(this.db, null, 2));
  }

  // Contract Metadata operations
  async createContractMetadata(data: Omit<ContractMetadata, 'id' | 'created_at' | 'updated_at'>): Promise<ContractMetadata> {
    const db = await this.loadDatabase();
    const metadata: ContractMetadata = {
      ...data,
      id: require('crypto').randomUUID(),
      created_at: new Date(),
      updated_at: new Date()
    };
    db.contract_metadata.push(metadata);
    await this.saveDatabase();
    return metadata;
  }

  async getContractMetadataByContractId(
    contractId: string,
    options: {
      page?: number;
      limit?: number;
      key?: string;
      data_type?: string;
      includeDeleted?: boolean;
    } = {}
  ): Promise<{ records: ContractMetadata[]; total: number; page: number; limit: number }> {
    const db = await this.loadDatabase();
    const { page = 1, limit = 20, key, data_type, includeDeleted = false } = options;

    let filtered = db.contract_metadata.filter(record => {
      if (record.contract_id !== contractId) return false;
      if (!includeDeleted && record.deleted_at) return false;
      if (key && record.key !== key) return false;
      if (data_type && record.data_type !== data_type) return false;
      return true;
    });

    const total = filtered.length;
    const startIndex = (page - 1) * limit;
    const records = filtered.slice(startIndex, startIndex + limit);

    return { records, total, page, limit };
  }

  async getContractMetadataById(id: string): Promise<ContractMetadata | null> {
    const db = await this.loadDatabase();
    return db.contract_metadata.find(record => record.id === id && !record.deleted_at) || null;
  }

  async updateContractMetadata(
    id: string,
    updates: Partial<Pick<ContractMetadata, 'value' | 'is_sensitive' | 'updated_by'>>
  ): Promise<ContractMetadata | null> {
    const db = await this.loadDatabase();
    const index = db.contract_metadata.findIndex(record => record.id === id && !record.deleted_at);
    
    if (index === -1) return null;

    db.contract_metadata[index] = {
      ...db.contract_metadata[index],
      ...updates,
      updated_at: new Date()
    };

    await this.saveDatabase();
    return db.contract_metadata[index];
  }

  async deleteContractMetadata(id: string): Promise<boolean> {
    const db = await this.loadDatabase();
    const record = db.contract_metadata.find(r => r.id === id && !r.deleted_at);
    
    if (!record) return false;

    record.deleted_at = new Date();
    record.updated_at = new Date();
    
    await this.saveDatabase();
    return true;
  }

  async findContractMetadataByKey(contractId: string, key: string): Promise<ContractMetadata | null> {
    const db = await this.loadDatabase();
    return db.contract_metadata.find(
      record => record.contract_id === contractId && record.key === key && !record.deleted_at
    ) || null;
  }

  // Contract operations
  async getContractById(id: string): Promise<Contract | null> {
    const db = await this.loadDatabase();
    return db.contracts.find(contract => contract.id === id && !contract.deleted_at) || null;
  }

  async createContract(data: Omit<Contract, 'id' | 'created_at' | 'updated_at'>): Promise<Contract> {
    const db = await this.loadDatabase();
    const contract: Contract = {
      ...data,
      id: require('crypto').randomUUID(),
      created_at: new Date(),
      updated_at: new Date()
    };
    db.contracts.push(contract);
    await this.saveDatabase();
    return contract;
  }

  // User operations
  async getUserById(id: string): Promise<User | null> {
    const db = await this.loadDatabase();
    return db.users.find(user => user.id === id) || null;
  }

  async createUser(data: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User> {
    const db = await this.loadDatabase();
    const user: User = {
      ...data,
      id: require('crypto').randomUUID(),
      created_at: new Date(),
      updated_at: new Date()
    };
    db.users.push(user);
    await this.saveDatabase();
    return user;
  }

  // Cleanup for testing
  async clearDatabase(): Promise<void> {
    this.db = {
      contract_metadata: [],
      contracts: [],
      users: [],
      api_keys: []
    };
    await this.saveDatabase();
  }

  // API Key operations
  async createApiKey(data: {
    name: string;
    key_hash: string;
    key_selector: string;
    scope: string[];
    created_by: string;
    expires_at?: Date;
    is_active: boolean;
  }): Promise<ApiKey> {
    const db = await this.loadDatabase();
    const apiKey: ApiKey = {
      id: require('crypto').randomUUID(),
      name: data.name,
      key_hash: data.key_hash,
      key_selector: data.key_selector,
      scope: data.scope,
      created_by: data.created_by,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: data.expires_at,
      is_active: data.is_active,
    };
    db.api_keys.push(apiKey);
    await this.saveDatabase();
    return apiKey;
  }

  async getApiKeyBySelector(selector: string): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    return db.api_keys.find((k) => k.key_selector === selector && k.is_active) || null;
  }

  async getApiKeyById(id: string): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    return db.api_keys.find((k) => k.id === id) || null;
  }

  async updateApiKey(
    id: string,
    updates: Partial<Pick<ApiKey, 'key_selector' | 'last_used_at'>>
  ): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    const index = db.api_keys.findIndex((k) => k.id === id);
    if (index === -1) return null;
    db.api_keys[index] = { ...db.api_keys[index], ...updates, updated_at: new Date() };
    await this.saveDatabase();
    return db.api_keys[index];
  }

  async rotateApiKey(id: string, keyHash: string, keySelector: string): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    const index = db.api_keys.findIndex((k) => k.id === id);
    if (index === -1) return null;
    db.api_keys[index] = {
      ...db.api_keys[index],
      key_hash: keyHash,
      key_selector: keySelector,
      updated_at: new Date(),
    };
    await this.saveDatabase();
    return db.api_keys[index];
  }

  async deactivateApiKey(id: string): Promise<boolean> {
    const db = await this.loadDatabase();
    const index = db.api_keys.findIndex((k) => k.id === id);
    if (index === -1) return false;
    db.api_keys[index].is_active = false;
    db.api_keys[index].updated_at = new Date();
    await this.saveDatabase();
    return true;
  }
}

export const database = new DatabaseService();
