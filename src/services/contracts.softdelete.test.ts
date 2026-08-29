import { InMemoryContractRepository } from "../repositories/contractRepository";
import {
  ContractsService,
  CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV,
} from "./contracts.service";
import { SoftDeleteRetentionError } from "../utils/softDelete";
import { NotFoundError } from "../errors/appError";

describe("ContractsService soft-delete", () => {
  let repo: InMemoryContractRepository;
  let service: ContractsService;

  beforeEach(() => {
    repo = new InMemoryContractRepository();
    service = new ContractsService(repo);
    delete process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    delete process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  async function seed(title = "Contract 1") {
    return service.createContract({
      title,
      clientId: "00000000-0000-0000-0000-000000000001",
      budget: 1000,
    });
  }

  it("create + list returns active contract; soft-delete hides it from default reads", async () => {
    const created = await seed();
    const all = await service.getAllContracts();
    expect(all).toHaveLength(1);
    expect((await service.getContractById(created.id))?.id).toBe(created.id);

    await service.deleteContract(created.id);

    const afterDelete = await service.getAllContracts();
    expect(afterDelete).toHaveLength(0);
    expect(await service.getContractById(created.id)).toBeUndefined();

    const withDeleted = await service.getAllContracts({ includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]!.deletedAt).toBeTruthy();

    const getDeleted = await service.getContractById(created.id, {
      includeDeleted: true,
    });
    expect(getDeleted?.id).toBe(created.id);
  });

  it("restore within retention window makes contract visible again", async () => {
    process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV] = "30";
    const created = await seed();
    const deleteTime = new Date("2026-01-01T00:00:00.000Z");
    await service.deleteContract(created.id, undefined, deleteTime);

    const restoreTime = new Date("2026-01-15T00:00:00.000Z");
    const restored = await service.restoreContract(
      created.id,
      undefined,
      restoreTime,
    );
    expect(restored.deletedAt).toBeNull();

    const all = await service.getAllContracts();
    expect(all).toHaveLength(1);
  });

  it("restore past retention window throws SoftDeleteRetentionError", async () => {
    process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV] = "30";
    const created = await seed();
    const deleteTime = new Date("2026-01-01T00:00:00.000Z");
    await service.deleteContract(created.id, undefined, deleteTime);

    const restoreTime = new Date("2026-03-01T00:00:00.000Z");
    await expect(
      service.restoreContract(created.id, undefined, restoreTime),
    ).rejects.toThrow(SoftDeleteRetentionError);
  });

  it("purgeExpiredContracts hard-deletes only expired soft-deleted records", async () => {
    process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV] = "30";
    const keepActive = await seed("Keep Active");
    const expiredTarget = await seed("Expired Target");
    const recentTarget = await seed("Recent Target");

    await service.deleteContract(
      expiredTarget.id,
      undefined,
      new Date("2025-01-01T00:00:00.000Z"),
    );
    await service.deleteContract(
      recentTarget.id,
      undefined,
      new Date("2026-07-01T00:00:00.000Z"),
    );

    const purgedCount = await service.purgeExpiredContracts(
      new Date("2026-07-20T00:00:00.000Z"),
    );
    expect(purgedCount).toBe(1);

    expect(await service.getContractById(keepActive.id)).toBeDefined();
    expect(
      await service.getContractById(recentTarget.id, { includeDeleted: true }),
    ).toBeDefined();
    expect(
      await service.getContractById(expiredTarget.id, { includeDeleted: true }),
    ).toBeUndefined();
  });

  it("soft-deleting missing or already soft-deleted contract throws NotFoundError", async () => {
    await expect(service.deleteContract("missing-id")).rejects.toThrow(
      NotFoundError,
    );

    const created = await seed();
    await service.deleteContract(created.id);
    await expect(service.deleteContract(created.id)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("restoring active contract throws error", async () => {
    const created = await seed();
    await expect(service.restoreContract(created.id)).rejects.toThrow(
      /not soft-deleted/i,
    );
  });

  it("reads retention days from env var", () => {
    expect(service.getRetentionDays()).toBe(30);
    process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV] = "14";
    expect(service.getRetentionDays()).toBe(14);
  });
});
