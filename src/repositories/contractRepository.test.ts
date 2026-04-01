/**
 * Integration tests for ContractRepository.
 *
 * Each test suite starts with a clean in-memory database so tests are
 * fully isolated and do not write to disk.  We pre-create two user rows to
 * satisfy the foreign-key constraints on `contracts.client_id` and
 * `contracts.freelancer_id`.
 */

import { getDb, closeDb } from "../db/database";
import { ContractRepository } from "./contractRepository";
import { UserRepository } from "./userRepository";

let contractRepo: ContractRepository;
let clientId: string;
let freelancerId: string;

beforeEach(() => {
  const db = getDb(":memory:");
  contractRepo = new ContractRepository(db);

  // Seed two users that contracts can reference
  const userRepo = new UserRepository(db);
  clientId = userRepo.create({
    username: "client1",
    email: "client@example.com",
    role: "client",
  }).id;
  freelancerId = userRepo.create({
    username: "freelancer1",
    email: "freelancer@example.com",
    role: "freelancer",
  }).id;
});

afterEach(() => {
  closeDb();
});

const baseData = () => ({
  title: "Build Stellar integration",
  clientId,
  freelancerId,
  amount: 5_000_000, // 0.5 XLM in stroops
});

describe("ContractRepository.findAll", () => {
  it("returns an empty array when no contracts exist", () => {
    expect(contractRepo.findAll()).toEqual([]);
  });

  it("returns all created contracts (both present)", () => {
    contractRepo.create({ ...baseData(), title: "First" });
    contractRepo.create({ ...baseData(), title: "Second" });
    const all = contractRepo.findAll();
    expect(all).toHaveLength(2);
    const titles = all.map((c) => c.title).sort();
    expect(titles).toEqual(["First", "Second"]);
  });
});

describe("ContractRepository.create", () => {
  it("creates a contract and returns it with a generated id", () => {
    const contract = contractRepo.create(baseData());
    expect(contract.id).toBeDefined();
    expect(contract.title).toBe("Build Stellar integration");
    expect(contract.clientId).toBe(clientId);
    expect(contract.freelancerId).toBe(freelancerId);
    expect(contract.amount).toBe(5_000_000);
    expect(contract.status).toBe("draft");
    expect(contract.createdAt).toBeDefined();
  });

  it("uses the provided status when given", () => {
    const contract = contractRepo.create({ ...baseData(), status: "active" });
    expect(contract.status).toBe("active");
  });

  it("persists the contract so findAll returns it", () => {
    const created = contractRepo.create(baseData());
    const all = contractRepo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(created.id);
  });

  it("throws when an invalid status is supplied (DB constraint)", () => {
    expect(() =>
      contractRepo.create({ ...baseData(), status: "invalid" as "draft" }),
    ).toThrow();
  });
});

describe("ContractRepository.findById", () => {
  it("returns the contract when the id exists", () => {
    const created = contractRepo.create(baseData());
    const found = contractRepo.findById(created.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
  });

  it("returns undefined for a non-existent id", () => {
    expect(contractRepo.findById("non-existent-id")).toBeUndefined();
  });
});

describe("ContractRepository.findByClientId", () => {
  it("returns contracts matching the client id", () => {
    contractRepo.create(baseData());
    contractRepo.create(baseData());
    const results = contractRepo.findByClientId(clientId);
    expect(results).toHaveLength(2);
    results.forEach((c) => expect(c.clientId).toBe(clientId));
  });

  it("returns empty array when client has no contracts", () => {
    expect(contractRepo.findByClientId("unknown-client")).toEqual([]);
  });
});

describe("ContractRepository.updateStatus", () => {
  it("updates the status and returns the updated contract", () => {
    const created = contractRepo.create(baseData());
    const updated = contractRepo.updateStatus(created.id, "active");
    expect(updated).toBeDefined();
    expect(updated?.status).toBe("active");
    expect(updated?.id).toBe(created.id);
  });

  it("returns undefined for a non-existent id", () => {
    const result = contractRepo.updateStatus("does-not-exist", "completed");
    expect(result).toBeUndefined();
  });

  it("persists status change across subsequent reads", () => {
    const created = contractRepo.create(baseData());
    contractRepo.updateStatus(created.id, "completed");
    const fetched = contractRepo.findById(created.id);
    expect(fetched?.status).toBe("completed");
  });

  it("transitions through all valid statuses", () => {
    const statuses = ["active", "completed", "disputed", "cancelled"] as const;
    const created = contractRepo.create(baseData());
    for (const s of statuses) {
      const updated = contractRepo.updateStatus(created.id, s);
      expect(updated?.status).toBe(s);
    }
  });
});

describe("ContractRepository.delete", () => {
  it("returns true and removes the contract", () => {
    const created = contractRepo.create(baseData());
    const result = contractRepo.delete(created.id);
    expect(result).toBe(true);
    expect(contractRepo.findById(created.id)).toBeUndefined();
  });

  it("returns false for a non-existent id", () => {
    expect(contractRepo.delete("ghost-id")).toBe(false);
  });
});
