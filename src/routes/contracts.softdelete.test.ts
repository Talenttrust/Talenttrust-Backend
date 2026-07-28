import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { randomUUID } from "crypto";

jest.mock("../middleware/authorization", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: "test-user-id" };
    next();
  },
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

import { createContractsRouter } from "./contracts.routes";
import { getDb, closeDb } from "../db/database";
import { ContractRepository } from "../repositories/contractRepository";
import { UserRepository } from "../repositories/userRepository";
import {
  ContractsService,
  CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV,
} from "../services/contracts.service";
import { runContractsSoftDeletePurge } from "../controllers/contracts.controller";

let clientId: string;
let freelancerId: string;
let service: ContractsService;
let testDb: any;

function buildApp(dbInstance = testDb) {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/contracts", createContractsRouter(undefined, dbInstance));
  return app;
}

describe("Contracts soft-delete routes", () => {
  beforeEach(() => {
    delete process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV];
    testDb = getDb(":memory:");
    const userRepo = new UserRepository(testDb);
    const suffix = randomUUID().substring(0, 8);
    clientId = userRepo.create({
      username: `client_sd_${suffix}`,
      email: `client_sd_${suffix}@example.com`,
      role: "client",
    }).id;
    freelancerId = userRepo.create({
      username: `freelancer_sd_${suffix}`,
      email: `freelancer_sd_${suffix}@example.com`,
      role: "freelancer",
    }).id;
    const repo = new ContractRepository(testDb);
    service = new ContractsService(repo);
  });

  afterEach(() => {
    closeDb();
    delete process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  async function createContract(
    app: express.Express,
    title = "Test Engagement",
  ) {
    return request(app)
      .post("/api/v1/contracts")
      .set("Idempotency-Key", randomUUID())
      .send({
        title,
        description: "Test Engagement Description",
        clientId,
        freelancerId,
        budget: 5000,
      });
  }

  it("DELETE soft-deletes; GET hides by default; GET with includeDeleted shows; restore brings back", async () => {
    const app = buildApp();
    const createRes = await createContract(app);
    expect(createRes.status).toBe(201);
    const contractId = createRes.body.data.id as string;

    const delRes = await request(app).delete(`/api/v1/contracts/${contractId}`);
    expect(delRes.status).toBe(200);

    const getRes = await request(app).get(`/api/v1/contracts/${contractId}`);
    expect(getRes.status).toBe(404);

    const getWithDeletedRes = await request(app).get(
      `/api/v1/contracts/${contractId}?includeDeleted=true`,
    );
    expect(getWithDeletedRes.status).toBe(200);
    expect(getWithDeletedRes.body.data.deletedAt).toBeTruthy();

    const listRes = await request(app).get("/api/v1/contracts");
    expect(listRes.status).toBe(200);
    const items = listRes.body.data ?? listRes.body;
    expect(items.find((c: any) => c.id === contractId)).toBeUndefined();

    const restoreRes = await request(app).post(
      `/api/v1/contracts/${contractId}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.deletedAt).toBeNull();

    const getAfterRestore = await request(app).get(
      `/api/v1/contracts/${contractId}`,
    );
    expect(getAfterRestore.status).toBe(200);
  });

  it("restore past retention window returns HTTP 410 Gone", async () => {
    process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV] = "30";
    const contract = await service.createContract({
      title: "Old Contract Description Title",
      clientId,
      freelancerId,
      budget: 1000,
    });

    const oldDeleteTime = new Date("2020-01-01T00:00:00.000Z");
    await service.deleteContract(contract.id, undefined, oldDeleteTime);

    const app = buildApp();
    const restoreRes = await request(app).post(
      `/api/v1/contracts/${contract.id}/restore`,
    );
    expect(restoreRes.status).toBe(410);
    expect(restoreRes.body.error.code).toBe("soft_delete_retention_expired");
  });

  it("DELETE unknown contract returns 404", async () => {
    const app = buildApp();
    const res = await request(app).delete(
      "/api/v1/contracts/non-existent-uuid",
    );
    expect(res.status).toBe(404);
  });

  it("runContractsSoftDeletePurge purges expired contracts", async () => {
    process.env[CONTRACTS_SOFT_DELETE_RETENTION_DAYS_ENV] = "30";
    const active = await service.createContract({
      title: "Active Engagement Description",
      clientId,
      freelancerId,
      budget: 100,
    });
    const expired = await service.createContract({
      title: "Expired Engagement Description",
      clientId,
      freelancerId,
      budget: 100,
    });

    await service.deleteContract(
      expired.id,
      undefined,
      new Date("2020-01-01T00:00:00.000Z"),
    );

    const purged = await runContractsSoftDeletePurge(
      service,
      new Date("2026-07-01T00:00:00.000Z"),
    );
    expect(purged).toBe(1);

    expect(await service.getContractById(active.id)).toBeDefined();
    expect(
      await service.getContractById(expired.id, { includeDeleted: true }),
    ).toBeUndefined();
  });
});
