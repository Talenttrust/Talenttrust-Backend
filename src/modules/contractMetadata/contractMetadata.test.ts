import { ContractMetadataService } from './contractMetadata.service';
import { contractMetadataRepository } from './contractMetadata.repository';
import { CreateContractMetadataRequest, UpdateContractMetadataRequest } from './contractMetadata.types';
import { SWRCache } from '../../utils/swrCache';

// Mock the repository
jest.mock('./contractMetadata.repository');
const mockRepository = contractMetadataRepository as jest.Mocked<typeof contractMetadataRepository>;

describe('ContractMetadataService', () => {
  let service: ContractMetadataService;
  const contractId = 'test-contract-id';
  const userId = 'test-user-id';
  const adminUser = { id: 'admin-id', email: 'admin@test.com', role: 'admin' as const };
  const regularUser = { id: userId, email: 'user@test.com', role: 'user' as const };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ContractMetadataService();
  });

  describe('create', () => {
    const validData: CreateContractMetadataRequest = {
      key: 'test-key',
      value: 'test-value',
      data_type: 'string',
      is_sensitive: false
    };

    it('should create metadata successfully', async () => {
      const expectedMetadata = {
        id: 'new-id',
        contract_id: contractId,
        ...validData,
        data_type: validData.data_type || 'string',
        is_sensitive: validData.is_sensitive || false,
        created_by: userId,
        updated_by: undefined,
        created_at: new Date(),
        updated_at: new Date()
      };

      mockRepository.getContractById.mockResolvedValue({ id: contractId } as any);
      mockRepository.findByContractAndKey.mockResolvedValue(null);
      mockRepository.create.mockResolvedValue(expectedMetadata);

      const result = await service.create(contractId, validData, userId);

      expect(mockRepository.getContractById).toHaveBeenCalledWith(contractId);
      expect(mockRepository.findByContractAndKey).toHaveBeenCalledWith(contractId, validData.key);
      expect(mockRepository.create).toHaveBeenCalledWith({
        contract_id: contractId,
        ...validData,
        created_by: userId
      });
      expect(result).toEqual({
        id: expectedMetadata.id,
        contract_id: expectedMetadata.contract_id,
        key: expectedMetadata.key,
        value: expectedMetadata.value,
        data_type: expectedMetadata.data_type,
        is_sensitive: expectedMetadata.is_sensitive,
        created_by: expectedMetadata.created_by,
        updated_by: expectedMetadata.updated_by,
        created_at: expectedMetadata.created_at.toISOString(),
        updated_at: expectedMetadata.updated_at.toISOString()
      });
    });

    it('should throw error if contract not found', async () => {
      mockRepository.getContractById.mockResolvedValue(null);

      await expect(service.create(contractId, validData, userId))
        .rejects.toThrow('Contract not found');
    });

    it('should throw error if duplicate key', async () => {
      mockRepository.getContractById.mockResolvedValue({ id: contractId } as any);
      mockRepository.findByContractAndKey.mockResolvedValue({ id: 'existing' } as any);

      await expect(service.create(contractId, validData, userId))
        .rejects.toThrow('Metadata key already exists for this contract');
    });
  });

  describe('list', () => {
    it('should return paginated metadata list', async () => {
      const mockRecords = [
        {
          id: '1',
          contract_id: contractId,
          key: 'key1',
          value: 'value1',
          data_type: 'string' as const,
          is_sensitive: false,
          created_by: userId,
          created_at: new Date(),
          updated_at: new Date()
        },
        {
          id: '2',
          contract_id: contractId,
          key: 'key2',
          value: 'sensitive-value',
          data_type: 'string' as const,
          is_sensitive: true,
          created_by: 'other-user',
          created_at: new Date(),
          updated_at: new Date()
        }
      ];

      mockRepository.getByContractId.mockResolvedValue({
        records: mockRecords,
        total: 2,
        page: 1,
        limit: 20
      });

      const result = await service.list(contractId, {}, regularUser);

      expect(result).toEqual({
        records: [
          {
            id: '1',
            contract_id: contractId,
            key: 'key1',
            value: 'value1',
            data_type: 'string',
            is_sensitive: false,
            created_by: userId,
            updated_by: undefined,
            created_at: mockRecords[0].created_at.toISOString(),
            updated_at: mockRecords[0].updated_at.toISOString()
          },
          {
            id: '2',
            contract_id: contractId,
            key: 'key2',
            value: '***REDACTED***',
            data_type: 'string',
            is_sensitive: true,
            created_by: 'other-user',
            updated_by: undefined,
            created_at: mockRecords[1].created_at.toISOString(),
            updated_at: mockRecords[1].updated_at.toISOString()
          }
        ],
        total: 2,
        page: 1,
        limit: 20
      });
    });

    it('should not mask sensitive values for owners', async () => {
      const mockRecord = {
        id: '1',
        contract_id: contractId,
        key: 'key1',
        value: 'sensitive-value',
        data_type: 'string' as const,
        is_sensitive: true,
        created_by: userId,
        created_at: new Date(),
        updated_at: new Date()
      };

      mockRepository.getByContractId.mockResolvedValue({
        records: [mockRecord],
        total: 1,
        page: 1,
        limit: 20
      });

      const result = await service.list(contractId, {}, regularUser);

      expect(result.records[0].value).toBe('sensitive-value');
    });

    it('should not mask sensitive values for admins', async () => {
      const mockRecord = {
        id: '1',
        contract_id: contractId,
        key: 'key1',
        value: 'sensitive-value',
        data_type: 'string' as const,
        is_sensitive: true,
        created_by: 'other-user',
        created_at: new Date(),
        updated_at: new Date()
      };

      mockRepository.getByContractId.mockResolvedValue({
        records: [mockRecord],
        total: 1,
        page: 1,
        limit: 20
      });

      const result = await service.list(contractId, {}, adminUser);

      expect(result.records[0].value).toBe('sensitive-value');
    });
  });

  describe('getById', () => {
    it('should return metadata by ID', async () => {
      const mockRecord = {
        id: '1',
        contract_id: contractId,
        key: 'key1',
        value: 'value1',
        data_type: 'string' as const,
        is_sensitive: false,
        created_by: userId,
        created_at: new Date(),
        updated_at: new Date()
      };

      mockRepository.getById.mockResolvedValue(mockRecord);

      const result = await service.getById('1', regularUser);

      expect(result).toEqual({
        id: '1',
        contract_id: contractId,
        key: 'key1',
        value: 'value1',
        data_type: 'string',
        is_sensitive: false,
        created_by: userId,
        updated_by: undefined,
        created_at: mockRecord.created_at.toISOString(),
        updated_at: mockRecord.updated_at.toISOString()
      });
    });

    it('should return null if not found', async () => {
      mockRepository.getById.mockResolvedValue(null);

      const result = await service.getById('nonexistent', regularUser);

      expect(result).toBeNull();
    });

    it('should mask sensitive values for non-owners', async () => {
      const mockRecord = {
        id: '1',
        contract_id: contractId,
        key: 'key1',
        value: 'sensitive-value',
        data_type: 'string' as const,
        is_sensitive: true,
        created_by: 'other-user',
        created_at: new Date(),
        updated_at: new Date()
      };

      mockRepository.getById.mockResolvedValue(mockRecord);

      const result = await service.getById('1', regularUser);

      expect(result?.value).toBe('***REDACTED***');
    });
  });

  describe('update', () => {
    const updates: UpdateContractMetadataRequest = {
      value: 'new-value',
      is_sensitive: true
    };

    it('should update metadata successfully', async () => {
      const existingRecord = {
        id: '1',
        contract_id: contractId,
        key: 'key1',
        value: 'old-value',
        data_type: 'string' as const,
        is_sensitive: false,
        created_by: userId,
        created_at: new Date(),
        updated_at: new Date()
      };

      const updatedRecord = {
        ...existingRecord,
        ...updates,
        updated_by: userId,
        updated_at: new Date()
      };

      mockRepository.getById.mockResolvedValue(existingRecord);
      mockRepository.update.mockResolvedValue(updatedRecord);

      const result = await service.update('1', updates, userId, regularUser);

      expect(mockRepository.update).toHaveBeenCalledWith('1', {
        ...updates,
        updated_by: userId
      });
      expect(result?.value).toBe('new-value');
      expect(result?.is_sensitive).toBe(true);
    });

    it('should return null if not found', async () => {
      mockRepository.getById.mockResolvedValue(null);

      const result = await service.update('nonexistent', updates, userId, regularUser);

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete metadata successfully', async () => {
      mockRepository.getById.mockResolvedValue({
        id: '1',
        contract_id: contractId,
        key: 'key1',
        value: 'value1',
        data_type: 'string' as const,
        is_sensitive: false,
        created_by: userId,
        created_at: new Date(),
        updated_at: new Date()
      });
      mockRepository.delete.mockResolvedValue(true);

      const result = await service.delete('1');

      expect(result).toBe(true);
      expect(mockRepository.delete).toHaveBeenCalledWith('1');
    });

    it('should return false if not found', async () => {
      mockRepository.getById.mockResolvedValue(null);
      mockRepository.delete.mockResolvedValue(false);

      const result = await service.delete('nonexistent');

      expect(result).toBe(false);
    });
  });
});

describe('ContractMetadataService cache behavior', () => {
  let service: ContractMetadataService;
  const contractId = 'cached-contract-id';
  const userId = 'cached-user-id';
  const regularUser = { id: userId, email: 'user@test.com', role: 'user' as const };
  const cacheConfig = { ttlMs: 1_000, swrMs: 5_000, maxEntries: 10 };

  const createService = (): ContractMetadataService =>
    new ContractMetadataService({
      repository: mockRepository,
      cache: new SWRCache({ maxEntries: cacheConfig.maxEntries }),
      cacheConfig,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = createService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should cache repeated list reads and refresh stale data in the background', async () => {
    const initialRecord = {
      id: 'cached-1',
      contract_id: contractId,
      key: 'key1',
      value: 'initial-value',
      data_type: 'string' as const,
      is_sensitive: false,
      created_by: userId,
      created_at: new Date('2026-06-26T00:00:00.000Z'),
      updated_at: new Date('2026-06-26T00:00:00.000Z'),
    };
    const refreshedRecord = {
      ...initialRecord,
      value: 'refreshed-value',
      updated_at: new Date('2026-06-26T00:00:02.000Z'),
    };

    mockRepository.getByContractId
      .mockResolvedValueOnce({
        records: [initialRecord],
        total: 1,
        page: 1,
        limit: 20,
      })
      .mockResolvedValueOnce({
        records: [refreshedRecord],
        total: 1,
        page: 1,
        limit: 20,
      });

    const first = await service.list(contractId, { page: 1, limit: 20 }, regularUser);
    expect(first.records[0].value).toBe('initial-value');
    expect(mockRepository.getByContractId).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_500);

    const second = await service.list(contractId, { page: 1, limit: 20 }, regularUser);
    expect(second.records[0].value).toBe('initial-value');
    expect(second.records[0].value).not.toBe('refreshed-value');

    await Promise.resolve();
    await Promise.resolve();

    expect(mockRepository.getByContractId).toHaveBeenCalledTimes(2);

    const third = await service.list(contractId, { page: 1, limit: 20 }, regularUser);
    expect(third.records[0].value).toBe('refreshed-value');
  });

  it('should invalidate cached list results after an update', async () => {
    const existingRecord = {
      id: 'cached-2',
      contract_id: contractId,
      key: 'key2',
      value: 'before-update',
      data_type: 'string' as const,
      is_sensitive: false,
      created_by: userId,
      created_at: new Date('2026-06-26T00:00:00.000Z'),
      updated_at: new Date('2026-06-26T00:00:00.000Z'),
    };
    const updatedRecord = {
      ...existingRecord,
      value: 'after-update',
      updated_by: userId,
      updated_at: new Date('2026-06-26T00:00:05.000Z'),
    };

    mockRepository.getByContractId
      .mockResolvedValueOnce({
        records: [existingRecord],
        total: 1,
        page: 1,
        limit: 20,
      })
      .mockResolvedValueOnce({
        records: [updatedRecord],
        total: 1,
        page: 1,
        limit: 20,
      });
    mockRepository.getById.mockResolvedValue(existingRecord);
    mockRepository.update.mockResolvedValue(updatedRecord);

    const cachedBeforeUpdate = await service.list(contractId, { page: 1, limit: 20 }, regularUser);
    expect(cachedBeforeUpdate.records[0].value).toBe('before-update');

    const result = await service.update(
      existingRecord.id,
      { value: 'after-update' },
      userId,
      regularUser,
    );

    expect(result?.value).toBe('after-update');

    const refreshed = await service.list(contractId, { page: 1, limit: 20 }, regularUser);
    expect(refreshed.records[0].value).toBe('after-update');
    expect(mockRepository.getByContractId).toHaveBeenCalledTimes(2);
  });

  it('should invalidate cached list results after creating a new record', async () => {
    const existingRecord = {
      id: 'cached-3',
      contract_id: contractId,
      key: 'key3',
      value: 'before-create',
      data_type: 'string' as const,
      is_sensitive: false,
      created_by: userId,
      created_at: new Date('2026-06-26T00:00:00.000Z'),
      updated_at: new Date('2026-06-26T00:00:00.000Z'),
    };
    const createdRecord = {
      id: 'created-1',
      contract_id: contractId,
      key: 'key4',
      value: 'after-create',
      data_type: 'string' as const,
      is_sensitive: false,
      created_by: userId,
      updated_by: undefined,
      created_at: new Date('2026-06-26T00:00:03.000Z'),
      updated_at: new Date('2026-06-26T00:00:03.000Z'),
    };

    mockRepository.getByContractId
      .mockResolvedValueOnce({
        records: [existingRecord],
        total: 1,
        page: 1,
        limit: 20,
      })
      .mockResolvedValueOnce({
        records: [existingRecord, createdRecord],
        total: 2,
        page: 1,
        limit: 20,
      });
    mockRepository.getContractById.mockResolvedValue({ id: contractId } as any);
    mockRepository.findByContractAndKey.mockResolvedValue(null);
    mockRepository.create.mockResolvedValue(createdRecord);

    const cachedBeforeCreate = await service.list(contractId, { page: 1, limit: 20 }, regularUser);
    expect(cachedBeforeCreate.records).toHaveLength(1);

    const result = await service.create(
      contractId,
      { key: 'key4', value: 'after-create', data_type: 'string', is_sensitive: false },
      userId,
    );

    expect(result.key).toBe('key4');

    const refreshed = await service.list(contractId, { page: 1, limit: 20 }, regularUser);
    expect(refreshed.records).toHaveLength(2);
    expect(refreshed.records[1].value).toBe('after-create');
    expect(mockRepository.getByContractId).toHaveBeenCalledTimes(2);
  });
});
