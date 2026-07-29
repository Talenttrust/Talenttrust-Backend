import { promises as fs } from 'fs';
import * as path from 'path';
import { Database, ContractMetadata, Contract, User, ApiKey } from './schema';
import { decodeCursor, encodeCursor } from '../contracts/cursor.repository';
import type { CursorPage, CursorPaginationInput } from '../contracts/cursor.types';
import { MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT } from '../utils/pagination';
import { getMetadataStore } from './sqliteStore';

const DB_PATH = path.join(__dirname, '../../data/database.json');

/**
 * DatabaseService
 *
 * `contract_metadata` and `api_keys` are persisted in SQLite through
 * `SqliteMetadataStore`. `contracts` and `users` remain in `data/database.json`
 * because `src/db/types.ts` defines conflicting shapes for those two entities
 * and the SQLite tables belong to that other model — see
 * `docs/persistence-json-to-sqlite.md`.
 *
 * Every public method below keeps the signature and return type it had when the
 * whole service was JSON-backed, so no caller needs to change.
 */
class DatabaseService {
  private db: Database | null = null;
  private imported = false;

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

  /**
   * Moves any legacy JSON metadata/API-key rows into SQLite exactly once per
   * process.
   *
   * The import is `INSERT OR IGNORE` inside a transaction, so it is safe if a
   * previous run already completed. Failures are swallowed deliberately: a
   * missing or unreadable JSON file is the normal steady state after migration
   * and must not take the service down.
   */
  private importLegacyRecords(): void {
    if (this.imported) return;
    this.imported = true;

    if (!this.db) return;

    const hasLegacyRows =
      (this.db.contract_metadata?.length ?? 0) > 0 || (this.db.api_keys?.length ?? 0) > 0;
    if (!hasLegacyRows) return;

    try {
      getMetadataStore().importFromJson({
        contract_metadata: this.db.contract_metadata,
        api_keys: this.db.api_keys
      });
    } catch {
      // Best-effort backfill; the store remains the source of truth.
    }
  }

  /** Ensures the JSON file has been read (for the legacy import) and returns the store. */
  private async store() {
    await this.loadDatabase();
    this.importLegacyRecords();
    return getMetadataStore();
  }

  // Contract Metadata operations
  async createContractMetadata(data: Omit<ContractMetadata, 'id' | 'created_at' | 'updated_at'>): Promise<ContractMetadata> {
    const store = await this.store();
    const now = new Date();
    const metadata: ContractMetadata = {
      ...data,
      id: require('crypto').randomUUID(),
      created_at: now,
      updated_at: now
    };
    return store.insertMetadata(metadata);
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
    const store = await this.store();
    const MAX_LIMIT = 100;
    const { page = 1, limit = 20, key, data_type, includeDeleted = false } = options;

    // Bound limit
    const boundedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);

    const listOptions: {
      offset: number;
      limit: number;
      key?: string;
      dataType?: string;
      includeDeleted: boolean;
    } = {
      offset: (page - 1) * boundedLimit,
      limit: boundedLimit,
      includeDeleted
    };
    if (key !== undefined) listOptions.key = key;
    if (data_type !== undefined) listOptions.dataType = data_type;

    const { records, total } = store.listMetadata(contractId, listOptions);

    return { records, total, page, limit: boundedLimit };
  }


  async getContractMetadataById(id: string): Promise<ContractMetadata | null> {
    const store = await this.store();
    return store.findMetadataById(id);
  }

  async updateContractMetadata(
    id: string,
    updates: Partial<Pick<ContractMetadata, 'value' | 'is_sensitive' | 'updated_by'>>
  ): Promise<ContractMetadata | null> {
    const store = await this.store();
    return store.updateMetadata(id, updates, new Date());
  }

  async deleteContractMetadata(id: string): Promise<boolean> {
    const store = await this.store();
    return store.softDeleteMetadata(id, new Date());
  }

  async findContractMetadataByKey(contractId: string, key: string): Promise<ContractMetadata | null> {
    const store = await this.store();
    return store.findMetadataByKey(contractId, key);
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
    const store = await this.store();
    const now = new Date();
    const apiKey: ApiKey = {
      ...data,
      id: require('crypto').randomUUID(),
      created_at: now,
      updated_at: now,
      call_count: 0
    };
    return store.insertApiKey(apiKey);
  }

  async getApiKeyById(id: string): Promise<ApiKey | null> {
    const store = await this.store();
    return store.findApiKeyById(id);
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const store = await this.store();
    return store.findActiveApiKeyBy('key_hash', keyHash);
  }

  async getApiKeyBySelector(selector: string): Promise<ApiKey | null> {
    const store = await this.store();
    return store.findActiveApiKeyBy('key_selector', selector);
  }

  /**
   * Returns a cursor-paginated, newest-first page of active API keys created by `userId`.
   *
   * Ordering is stable (created_at DESC, id DESC as tie-breaker) so that concurrent
   * inserts never shift already-issued cursors. `limit` is bounded to
   * [1, MAX_PAGE_LIMIT] and silently clamped rather than rejected; omitted or
   * non-positive values fall back to DEFAULT_PAGE_LIMIT. An invalid `cursor`
   * throws and must be handled by the caller.
   */
  async listApiKeysPage(userId: string, input: CursorPaginationInput = {}): Promise<CursorPage<ApiKey>> {
    const store = await this.store();
    const limit =
      input.limit !== undefined && Number.isFinite(input.limit) && input.limit >= 1
        ? Math.min(Math.trunc(input.limit), MAX_PAGE_LIMIT)
        : DEFAULT_PAGE_LIMIT;

    // decodeCursor throws on a malformed cursor; that propagates to the caller
    // exactly as it did before.
    const position = input.cursor ? decodeCursor(input.cursor) : null;

    // The store fetches limit + 1 rows so the extra row signals a further page.
    const fetched = store.listApiKeysAfter(userId, limit, position);

    const hasNextPage = fetched.length > limit;
    const data = fetched.slice(0, limit);
    const lastItem = data.at(-1);
    const nextCursor =
      hasNextPage && lastItem
        ? encodeCursor({ createdAt: new Date(lastItem.created_at).toISOString(), id: lastItem.id })
        : null;

    return { data, nextCursor, hasNextPage, limit };
  }

  async updateApiKey(id: string, updates: Partial<Pick<ApiKey, 'name' | 'scope' | 'expires_at' | 'is_active' | 'last_used_at' | 'key_selector'>>): Promise<ApiKey | null> {
    const store = await this.store();
    return store.updateApiKey(id, updates, new Date());
  }

  async deactivateApiKey(id: string): Promise<boolean> {
    const store = await this.store();
    return store.setApiKeyActive(id, false, new Date());
  }

  async incrementApiKeyUsage(id: string, count: number, lastUsedAt: Date): Promise<void> {
    const store = await this.store();
    store.incrementApiKeyUsage(id, count, lastUsedAt);
    if (this.db) {
      const index = this.db.api_keys.findIndex((k) => k.id === id);
      if (index !== -1) {
        this.db.api_keys[index].call_count = (this.db.api_keys[index].call_count || 0) + count;
        this.db.api_keys[index].last_used_at = lastUsedAt;
        this.db.api_keys[index].updated_at = new Date();
      }
    }
  }

  async rotateApiKey(id: string, newKeyHash: string, newKeySelector?: string): Promise<ApiKey | null> {
    const store = await this.store();
    return store.rotateApiKey(id, newKeyHash, newKeySelector, new Date());
  }

  /**
   * Backfills the key_selector field for all existing API keys that lack it.
   *
   * For security, this function does NOT attempt to recompute selectors from
   * stored hashes (impossible). Instead it is provided as a hook; callers pass
   * plain-text keys that are being validated and the selector is backfilled
   * lazily in validateApiKey. This method counts unindexed keys for
   * monitoring/reporting.
   */
  async backfillKeySelectors(): Promise<number> {
    const store = await this.store();
    return store.countApiKeysWithoutSelector();
  }

  // Cleanup for testing
  async clearDatabase(): Promise<void> {
    this.db = {
      contract_metadata: [],
      contracts: [],
      users: [],
      api_keys: []
    };
    this.imported = true;
    getMetadataStore().clear();
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
      last_used_at: undefined,
      call_count: 0,
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
