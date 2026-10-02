import { promises as fs } from 'fs';
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
    // Fix 7: write-rename pattern for crash-safe atomic saves.
    // On POSIX, fs.rename is atomic. On Windows it is near-atomic (replaces target),
    // but may fail with EPERM when the target is locked. We fall back to a direct
    // writeFile in that case to preserve availability without data loss.
    const tmpPath = `${DB_PATH}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.db, null, 2), 'utf-8');
    try {
      await fs.rename(tmpPath, DB_PATH);
    } catch (renameErr: any) {
      // Windows EPERM / EXDEV: fall back to direct overwrite and clean up the tmp file
      if (renameErr.code === 'EPERM' || renameErr.code === 'EXDEV') {
        await fs.writeFile(DB_PATH, JSON.stringify(this.db, null, 2), 'utf-8');
        try { await fs.unlink(tmpPath); } catch { /* ignore cleanup failure */ }
      } else {
        try { await fs.unlink(tmpPath); } catch { /* ignore cleanup failure */ }
        throw renameErr;
      }
    }
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
    const MAX_LIMIT = 100;
    const { page = 1, limit = 20, key, data_type, includeDeleted = false } = options;
    
    // Bound limit
    const boundedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);

    let filtered = db.contract_metadata.filter(record => {
      if (record.contract_id !== contractId) return false;
      if (!includeDeleted && record.deleted_at) return false;
      if (key && record.key !== key) return false;
      if (data_type && record.data_type !== data_type) return false;
      return true;
    });

    // Stable sorting: latest first, then by ID for absolute stability
    filtered.sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();
      if (dateB !== dateA) return dateB - dateA;
      return a.id.localeCompare(b.id);
    });

    const total = filtered.length;
    const startIndex = (page - 1) * boundedLimit;
    const records = filtered.slice(startIndex, startIndex + boundedLimit);

    return { records, total, page, limit: boundedLimit };
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

  // API Key operations
  async createApiKey(data: Omit<ApiKey, 'id' | 'created_at' | 'updated_at'>): Promise<ApiKey> {
    const db = await this.loadDatabase();
    const apiKey: ApiKey = {
      ...data,
      id: require('crypto').randomUUID(),
      created_at: new Date(),
      updated_at: new Date()
    };
    db.api_keys.push(apiKey);
    await this.saveDatabase();
    return apiKey;
  }

  async getApiKeyById(id: string): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    return db.api_keys.find(key => key.id === id && key.is_active) || null;
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    return db.api_keys.find(key => key.key_hash === keyHash && key.is_active) || null;
  }

  async getApiKeyBySelector(selector: string): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    return db.api_keys.find(key => key.key_selector === selector && key.is_active) || null;
  }

  async updateApiKey(id: string, updates: Partial<Pick<ApiKey, 'name' | 'scope' | 'expires_at' | 'is_active' | 'last_used_at' | 'key_selector'>>): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    const index = db.api_keys.findIndex(key => key.id === id);
    
    if (index === -1) return null;

    db.api_keys[index] = {
      ...db.api_keys[index],
      ...updates,
      updated_at: new Date()
    };

    await this.saveDatabase();
    return db.api_keys[index];
  }

  async deactivateApiKey(id: string): Promise<boolean> {
    const db = await this.loadDatabase();
    const apiKey = db.api_keys.find(key => key.id === id);
    
    if (!apiKey) return false;

    apiKey.is_active = false;
    apiKey.updated_at = new Date();
    
    await this.saveDatabase();
    return true;
  }

  async rotateApiKey(id: string, newKeyHash: string, newKeySelector?: string): Promise<ApiKey | null> {
    const db = await this.loadDatabase();
    const apiKey = db.api_keys.find(key => key.id === id);
    
    if (!apiKey) return null;

    apiKey.key_hash = newKeyHash;
    if (newKeySelector !== undefined) {
      apiKey.key_selector = newKeySelector;
    }
    apiKey.updated_at = new Date();
    
    await this.saveDatabase();
    return apiKey;
  }

  /**
   * Backfills the key_selector field for all existing API keys that lack it.
   * Uses the stored key_hash (salt:hash) to derive the selector deterministically.
   * This must be called with the original plain-text key — we store the selector
   * during createApiKey, so this is only needed for legacy keys.
   *
   * For security, this function does NOT attempt to recompute selectors from
   * stored hashes (impossible). Instead it is provided as a hook; callers pass
   * plain-text keys that are being validated and the selector is backfilled
   * lazily in validateApiKey.
   */
  async backfillKeySelectors(): Promise<number> {
    const db = await this.loadDatabase();
    let count = 0;
    for (const key of db.api_keys) {
      if (!key.key_selector) {
        // Selector cannot be derived from stored hash; it must be set during
        // validation when the plain-text key is available (handled in validateApiKey).
        // This method counts unindexed keys for monitoring/reporting.
        count++;
      }
    }
    return count;
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
}

export const database = new DatabaseService();
