/**
 * @file milestones.flag.test.ts
 *
 * Unit tests for the MILESTONES_ENABLED feature flag in ContractsService.
 *
 * Covers:
 *  - Default behaviour (flag is true when env var is absent)
 *  - Flag ON  — milestone validation and enforcement are active
 *  - Flag OFF — milestone fields are silently stripped, no validation errors
 *  - Constructor injection (no process.env mutation needed in individual tests)
 *  - parseBoolEnv reading from process.env at construction time
 */

import { ContractsService } from './contracts.service';
import { ContractBoundsError } from '../contracts/bounds';
import { MAX_MILESTONES_PER_CONTRACT } from '../contracts/bounds';
import { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';

jest.mock('./soroban.service');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a mock repository with no-op stubs. */
function makeRepo(overrides: Partial<{
  create: jest.Mock;
  updateWithVersion: jest.Mock;
  findById: jest.Mock;
  findAll: jest.Mock;
  findPage: jest.Mock;
  delete: jest.Mock;
}> = {}) {
  const fakeContract = {
    id: 'contract-abc',
    title: 'Test Contract',
    clientId: 'client-1',
    freelancerId: '',
    amount: 10_000,
    status: 'draft',
    version: 0,
    createdAt: new Date().toISOString(),
  };
  return {
    create: jest.fn().mockResolvedValue(fakeContract),
    updateWithVersion: jest.fn().mockResolvedValue({ ...fakeContract, version: 1 }),
    findById: jest.fn().mockResolvedValue(fakeContract),
    findAll: jest.fn().mockResolvedValue([]),
    findPage: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasNextPage: false, limit: 20 }),
    delete: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** Minimal valid CreateContractDto with milestones attached. */
function makeCreateDto(milestonesOverride?: object | null): CreateContractDto {
  const base: CreateContractDto = {
    title: 'Flag Test Contract',
    description: 'Testing the milestones feature flag',
    clientId: '550e8400-e29b-41d4-a716-446655440000',
    budget: 10_000,
  };
  if (milestonesOverride === null) return base; // no milestones
  if (milestonesOverride !== undefined) return { ...base, milestones: milestonesOverride as any };
  return {
    ...base,
    milestones: [{ title: 'Phase 1', amount: 3_000 }],
  };
}

/** Minimal valid UpdateContractDto with milestones attached. */
function makeUpdateDto(milestones?: object[]): UpdateContractDto {
  return {
    version: 0,
    title: 'Updated Title',
    ...(milestones !== undefined ? { milestones } : {}),
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Ensure the env var is clean before each test
  delete process.env.MILESTONES_ENABLED;
});

afterAll(() => {
  delete process.env.MILESTONES_ENABLED;
});

// ─── Default behaviour (no MILESTONES_ENABLED set) ───────────────────────────

describe('MILESTONES_ENABLED default behaviour', () => {
  it('defaults to enabled (true) when env var is absent', () => {
    delete process.env.MILESTONES_ENABLED;
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(true);
  });

  it('defaults to enabled when env var is empty string', () => {
    process.env.MILESTONES_ENABLED = '';
    // parseBoolEnv treats empty string as undefined → uses default true
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(true);
  });

  it('with default flag, milestone validation is active — too many milestones throw ContractBoundsError', async () => {
    delete process.env.MILESTONES_ENABLED;
    const repo = makeRepo();
    const service = new ContractsService(repo as any);
    (service as any).sorobanService = { prepareEscrow: jest.fn().mockResolvedValue(undefined) };

    const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
      title: `MS-${i + 1}`,
      amount: 100,
    }));

    await expect(
      service.createContract({ ...makeCreateDto(null), milestones: milestones as any }),
    ).rejects.toBeInstanceOf(ContractBoundsError);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

// ─── Flag ON (milestonesEnabled = true) ──────────────────────────────────────

describe('MILESTONES_ENABLED=true (flag on)', () => {
  let service: ContractsService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
    service = new ContractsService(repo as any, true);
    (service as any).sorobanService = { prepareEscrow: jest.fn().mockResolvedValue(undefined) };
  });

  it('stores milestonesEnabled=true internally', () => {
    expect((service as any).milestonesEnabled).toBe(true);
  });

  describe('createContract', () => {
    it('accepts valid milestones and creates the contract', async () => {
      const dto = makeCreateDto();
      await expect(service.createContract(dto)).resolves.toBeDefined();
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('accepts contracts without milestones', async () => {
      const dto = makeCreateDto(null);
      await expect(service.createContract(dto)).resolves.toBeDefined();
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('rejects when milestone count exceeds MAX_MILESTONES_PER_CONTRACT', async () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `MS-${i + 1}`,
        amount: 100,
      }));
      await expect(
        service.createContract({ ...makeCreateDto(null), milestones: milestones as any }),
      ).rejects.toBeInstanceOf(ContractBoundsError);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects when total milestone amount exceeds budget', async () => {
      const milestones = [{ title: 'Over budget', amount: 99_999 }];
      await expect(
        service.createContract({ ...makeCreateDto(null), budget: 1_000, milestones: milestones as any }),
      ).rejects.toBeInstanceOf(ContractBoundsError);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('accepts milestones totalling exactly the budget', async () => {
      const milestones = [{ title: 'Exact', amount: 10_000 }];
      await expect(
        service.createContract({ ...makeCreateDto(null), milestones: milestones as any }),
      ).resolves.toBeDefined();
    });

    it('rejects when milestone count is exactly MAX + 1', async () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, () => ({
        title: 'M',
        amount: 1,
      }));
      await expect(
        service.createContract({ ...makeCreateDto(null), milestones: milestones as any }),
      ).rejects.toThrow(/exceeds maximum of/);
    });
  });

  describe('updateContract', () => {
    it('rejects update when milestone count exceeds MAX_MILESTONES_PER_CONTRACT', async () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `MS-${i + 1}`,
        description: `Desc ${i + 1}`,
        amount: 100,
        completed: false,
      }));
      await expect(
        service.updateContract('contract-abc', makeUpdateDto(milestones)),
      ).rejects.toBeInstanceOf(ContractBoundsError);
      expect(repo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('passes milestones through to the repository when valid', async () => {
      // updateContract maps milestones but doesn't store them in updateFields —
      // so repo.updateWithVersion is called; milestone validation runs clean.
      const milestones = [{ title: 'Phase 1', description: 'Desc', amount: 500, completed: false }];
      await expect(service.updateContract('contract-abc', makeUpdateDto(milestones))).resolves.toBeDefined();
      expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Flag OFF (milestonesEnabled = false) ────────────────────────────────────

describe('MILESTONES_ENABLED=false (flag off)', () => {
  let service: ContractsService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
    service = new ContractsService(repo as any, false);
    (service as any).sorobanService = { prepareEscrow: jest.fn().mockResolvedValue(undefined) };
  });

  it('stores milestonesEnabled=false internally', () => {
    expect((service as any).milestonesEnabled).toBe(false);
  });

  describe('createContract', () => {
    it('silently strips milestones and still creates the contract', async () => {
      const dto = makeCreateDto(); // has milestones
      const result = await service.createContract(dto);
      expect(result).toBeDefined();
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('does NOT throw ContractBoundsError even when milestone count exceeds max', async () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `MS-${i + 1}`,
        amount: 100,
      }));
      await expect(
        service.createContract({ ...makeCreateDto(null), milestones: milestones as any }),
      ).resolves.toBeDefined();
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('does NOT throw ContractBoundsError even when total milestone amount exceeds budget', async () => {
      const milestones = [{ title: 'Huge', amount: 999_999_999 }];
      await expect(
        service.createContract({ ...makeCreateDto(null), budget: 1_000, milestones: milestones as any }),
      ).resolves.toBeDefined();
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('creates a contract without milestones even when none supplied', async () => {
      const dto = makeCreateDto(null);
      await expect(service.createContract(dto)).resolves.toBeDefined();
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('repository.create is called with the correct non-milestone fields', async () => {
      const dto: CreateContractDto = {
        title: 'Flag Off Contract',
        description: 'Testing flag off',
        clientId: 'client-xyz',
        budget: 5_000,
        milestones: [{ title: 'Should be stripped', amount: 1_000 }] as any,
      };
      await service.createContract(dto);
      expect(repo.create).toHaveBeenCalledWith({
        title: 'Flag Off Contract',
        clientId: 'client-xyz',
        freelancerId: '',
        amount: 5_000,
        status: 'draft',
      });
    });
  });

  describe('updateContract', () => {
    it('silently strips milestones and still updates the contract', async () => {
      const milestones = [{ title: 'M', description: 'D', amount: 500, completed: false }];
      await expect(
        service.updateContract('contract-abc', makeUpdateDto(milestones)),
      ).resolves.toBeDefined();
      expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    });

    it('does NOT throw ContractBoundsError even when milestone count exceeds max on update', async () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `MS-${i + 1}`,
        description: `Desc ${i + 1}`,
        amount: 100,
        completed: false,
      }));
      await expect(
        service.updateContract('contract-abc', makeUpdateDto(milestones)),
      ).resolves.toBeDefined();
      expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    });

    it('updateWithVersion is called with milestone field absent when flag is off', async () => {
      const milestones = [{ title: 'M', description: 'D', amount: 500, completed: false }];
      await service.updateContract('contract-abc', { version: 0, title: 'New Title', milestones: milestones as any });
      // Only title (non-milestone field) should reach the repo
      expect(repo.updateWithVersion).toHaveBeenCalledWith(
        'contract-abc',
        { title: 'New Title' },
        0,
      );
    });

    it('still enforces version validation when flag is off', async () => {
      const { MissingVersionError } = await import('../errors/appError');
      await expect(
        service.updateContract('contract-abc', { version: undefined as any, title: 'title' }),
      ).rejects.toBeInstanceOf(MissingVersionError);
    });
  });
});

// ─── env var parsing at construction time ────────────────────────────────────

describe('MILESTONES_ENABLED env-var construction', () => {
  afterEach(() => {
    delete process.env.MILESTONES_ENABLED;
  });

  it('reads true from process.env.MILESTONES_ENABLED="true"', () => {
    process.env.MILESTONES_ENABLED = 'true';
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(true);
  });

  it('reads false from process.env.MILESTONES_ENABLED="false"', () => {
    process.env.MILESTONES_ENABLED = 'false';
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(false);
  });

  it('reads true from process.env.MILESTONES_ENABLED="1"', () => {
    process.env.MILESTONES_ENABLED = '1';
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(true);
  });

  it('reads false from process.env.MILESTONES_ENABLED="0"', () => {
    process.env.MILESTONES_ENABLED = '0';
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(false);
  });

  it('reads true from process.env.MILESTONES_ENABLED="TRUE" (case-insensitive)', () => {
    process.env.MILESTONES_ENABLED = 'TRUE';
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(true);
  });

  it('reads false from process.env.MILESTONES_ENABLED="FALSE" (case-insensitive)', () => {
    process.env.MILESTONES_ENABLED = 'FALSE';
    const service = new ContractsService(makeRepo() as any);
    expect((service as any).milestonesEnabled).toBe(false);
  });

  it('constructor injection overrides env var — true wins even when env is false', () => {
    process.env.MILESTONES_ENABLED = 'false';
    const service = new ContractsService(makeRepo() as any, true);
    expect((service as any).milestonesEnabled).toBe(true);
  });

  it('constructor injection overrides env var — false wins even when env is true', () => {
    process.env.MILESTONES_ENABLED = 'true';
    const service = new ContractsService(makeRepo() as any, false);
    expect((service as any).milestonesEnabled).toBe(false);
  });

  it('throws on unrecognised env var value (parseBoolEnv strict)', () => {
    process.env.MILESTONES_ENABLED = 'yes'; // not "true"/"false"/"1"/"0"
    expect(() => new ContractsService(makeRepo() as any)).toThrow();
  });
});

// ─── env.schema.ts MILESTONES_ENABLED validation ─────────────────────────────

describe('MILESTONES_ENABLED in env.schema.ts', () => {
  // Import validateEnv lazily so process.env changes take effect
  async function parseFlag(value: string | undefined): Promise<boolean | undefined> {
    const { envSchema } = await import('../config/env.schema');
    const result = envSchema.safeParse({
      COMPLIANCE_AUDIT_SECRET: 'a-32-char-secret-string-abcdefgh',
      ...(value !== undefined ? { MILESTONES_ENABLED: value } : {}),
    });
    if (!result.success) return undefined;
    return result.data.MILESTONES_ENABLED;
  }

  it('defaults to true when env var is absent', async () => {
    expect(await parseFlag(undefined)).toBe(true);
  });

  it('parses "true" as true', async () => {
    expect(await parseFlag('true')).toBe(true);
  });

  it('parses "false" as false', async () => {
    expect(await parseFlag('false')).toBe(false);
  });

  it('parses "TRUE" as true (case-insensitive transform)', async () => {
    expect(await parseFlag('TRUE')).toBe(true);
  });

  it('parses "FALSE" as false (case-insensitive transform)', async () => {
    expect(await parseFlag('FALSE')).toBe(false);
  });

  it('parses any non-"false" string as true (opt-in transform)', async () => {
    // The schema uses `val !== 'false'` after lowercasing, so "1" → true
    expect(await parseFlag('1')).toBe(true);
  });
});

// ─── AppConfig.milestonesEnabled via loadConfig ───────────────────────────────

describe('AppConfig.milestonesEnabled via loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    delete process.env.MILESTONES_ENABLED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to true when env var is absent', async () => {
    delete process.env.MILESTONES_ENABLED;
    const { loadConfig } = await import('../appConfiguration');
    const config = loadConfig({ UPSTREAM_CONTRACTS_URL: undefined });
    expect(config.milestonesEnabled).toBe(true);
  });

  it('is true when MILESTONES_ENABLED=true', async () => {
    const { loadConfig } = await import('../appConfiguration');
    const config = loadConfig({ MILESTONES_ENABLED: 'true' });
    expect(config.milestonesEnabled).toBe(true);
  });

  it('is false when MILESTONES_ENABLED=false', async () => {
    const { loadConfig } = await import('../appConfiguration');
    const config = loadConfig({ MILESTONES_ENABLED: 'false' });
    expect(config.milestonesEnabled).toBe(false);
  });

  it('is true when MILESTONES_ENABLED=TRUE (case-insensitive)', async () => {
    const { loadConfig } = await import('../appConfiguration');
    const config = loadConfig({ MILESTONES_ENABLED: 'TRUE' });
    expect(config.milestonesEnabled).toBe(true);
  });

  it('is false when MILESTONES_ENABLED=FALSE (case-insensitive)', async () => {
    const { loadConfig } = await import('../appConfiguration');
    const config = loadConfig({ MILESTONES_ENABLED: 'FALSE' });
    expect(config.milestonesEnabled).toBe(false);
  });
});
