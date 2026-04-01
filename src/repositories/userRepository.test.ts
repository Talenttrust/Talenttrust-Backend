/**
 * Integration tests for UserRepository.
 *
 * Each test suite uses an isolated in-memory SQLite database.
 */

import { getDb, closeDb } from "../db/database";
import { UserRepository } from "./userRepository";

let userRepo: UserRepository;

beforeEach(() => {
  const db = getDb(":memory:");
  userRepo = new UserRepository(db);
});

afterEach(() => {
  closeDb();
});

const baseData = () => ({
  username: "alice",
  email: "alice@example.com",
  role: "client" as const,
});

describe("UserRepository.findAll", () => {
  it("returns an empty array when no users exist", () => {
    expect(userRepo.findAll()).toEqual([]);
  });

  it("returns all users (both present)", () => {
    userRepo.create({ username: "a", email: "a@example.com", role: "client" });
    userRepo.create({
      username: "b",
      email: "b@example.com",
      role: "freelancer",
    });
    const all = userRepo.findAll();
    expect(all).toHaveLength(2);
    const usernames = all.map((u) => u.username).sort();
    expect(usernames).toEqual(["a", "b"]);
  });
});

describe("UserRepository.create", () => {
  it("creates a user with a generated id and createdAt", () => {
    const user = userRepo.create(baseData());
    expect(user.id).toBeDefined();
    expect(user.username).toBe("alice");
    expect(user.email).toBe("alice@example.com");
    expect(user.role).toBe("client");
    expect(user.createdAt).toBeDefined();
  });

  it("creates users for all valid roles", () => {
    const roles = ["client", "freelancer", "both"] as const;
    roles.forEach((role, i) => {
      const user = userRepo.create({
        username: `user${i}`,
        email: `user${i}@example.com`,
        role,
      });
      expect(user.role).toBe(role);
    });
  });

  it("throws on duplicate username (UNIQUE constraint)", () => {
    userRepo.create(baseData());
    expect(() =>
      userRepo.create({ ...baseData(), email: "other@example.com" }),
    ).toThrow();
  });

  it("throws on duplicate email (UNIQUE constraint)", () => {
    userRepo.create(baseData());
    expect(() =>
      userRepo.create({ ...baseData(), username: "other" }),
    ).toThrow();
  });

  it("throws for an invalid role (DB CHECK constraint)", () => {
    expect(() =>
      userRepo.create({
        username: "bad",
        email: "bad@example.com",
        role: "admin" as "client",
      }),
    ).toThrow();
  });
});

describe("UserRepository.findById", () => {
  it("returns the user when id exists", () => {
    const created = userRepo.create(baseData());
    const found = userRepo.findById(created.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
  });

  it("returns undefined for unknown id", () => {
    expect(userRepo.findById("unknown")).toBeUndefined();
  });
});

describe("UserRepository.findByEmail", () => {
  it("returns the user for a known email", () => {
    const created = userRepo.create(baseData());
    const found = userRepo.findByEmail("alice@example.com");
    expect(found?.id).toBe(created.id);
  });

  it("returns undefined for an unknown email", () => {
    expect(userRepo.findByEmail("ghost@example.com")).toBeUndefined();
  });
});

describe("UserRepository.delete", () => {
  it("deletes an existing user and returns true", () => {
    const created = userRepo.create(baseData());
    expect(userRepo.delete(created.id)).toBe(true);
    expect(userRepo.findById(created.id)).toBeUndefined();
  });

  it("returns false for a non-existent id", () => {
    expect(userRepo.delete("non-existent")).toBe(false);
  });

  it("removes only the targeted user", () => {
    const keep = userRepo.create({
      username: "keep",
      email: "keep@example.com",
      role: "client",
    });
    const remove = userRepo.create({
      username: "remove",
      email: "remove@example.com",
      role: "freelancer",
    });
    userRepo.delete(remove.id);
    expect(userRepo.findAll()).toHaveLength(1);
    expect(userRepo.findById(keep.id)).toBeDefined();
  });
});
