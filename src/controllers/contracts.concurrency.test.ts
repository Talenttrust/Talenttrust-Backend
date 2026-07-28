/**
 * Concurrency smoke tests for the contracts endpoint (#854).
 *
 * Tests three layers:
 *  1. Repository layer (InMemoryContractRepository) — synchronous OCC
 *  2. Repository layer (ContractRepository / SQLite) — atomic SQL OCC
 *  3. HTTP layer (full Express app + in-memory SQLite) — end-to-end
 *
 * Scenarios covered:
 *  - Parallel reads return consistent, non-corrupt data
 *  - Parallel writes with the same version: exactly one succeeds, rest get 409
 *  - Read-after-write reflects the winning update immediately
 *  - No lost updates: version counter is always exactly N after N sequential updates
 *  - High-fan-out concurrent writes (10 goroutines against one contract)
 *  - Sequential OCC chain: each writer reads the latest version before updating
 *  - Parallel creates produce unique IDs with no collisions
 *  - Parallel deletes: exactly one succeeds, the rest get false / 404
 */

// Set env vars BEFORE any module-level imports so singletons pick them up.
process.env.JWT_SECRET = 'concurrency-test-secret-key';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

import { getDb } from '../db/database';
import { ContractRepository, InMemoryContractRepository } from '../repositories/contractRepository';
import { ContractsService } from '../services/contracts.service';
import { VersionConflictError } from '../errors/appError';
import app from '../index';

// ─── Token helpers ────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;

const ADMIN_ID     = 'aa000000-0000-0000-0000-000000000001';
const CLIENT_ID    = 'cc000000-0000-0000-0000-000000000002';
const FREELANCER_ID = 'ff000000-0000-0000-0000-000000000003';

function makeToken(role: string, sub: string, expiresIn: string | number = '1h'): string {
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, {
    expiresIn,
  } as Parameters<typeof jwt.sign>[2]) as string;
}

const adminToken     = () => makeToken('admin', ADMIN_ID);

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Shared contract payload ──────────────────────────────────────────────────

const validPayload = {
  title: 'Concurrency Smoke Test Contract',
  description: 'A contract used specifically for concurrency smoke testing.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 10_000,
};

// ─── Seed users (HTTP-layer tests) ────────────────────────────────────────────

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  const users = [
    [ADMIN_ID,      'concadmin',      'concadmin@test.com',      'admin'],
    [CLIENT_ID,     'concclient',     'concclient@test.com',     'client'],
    [FREELANCER_ID, 'concfreelancer', 'concfreelancer@test.com', 'freelancer'],
  ] as const;

  for (const [id, username, email, role] of users) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, username, email, role, now);
  }
});

beforeEach(() => {
  // Clean contracts table between tests so each test starts from a known state.
  const db = getDb();
  db.exec('DELETE FROM contracts');
});

// ─── HTTP helper: create a contract as admin ──────────────────────────────────

async function createContractViaHttp(): Promise<{ id: string; version: number }> {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...authHeader(adminToken()), 'Idempotency-Key': randomUUID() })
    .send(validPayload);

  expect(res.status).toBe(201);
  const data = (res.body as { data: { id: string; version: number } }).data;
  return { id: data.id, version: data.version };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. InMemoryContractRepository — OCC concurrency
// ═══════════════════════════════════════════════════════════════════════════

describe('InMemoryContractRepository — concurrency smoke tests', () => {
  let repo: InMemoryContractRepository;

  /** Seed a fresh contract and return it. */
  async function seedContract() {
    return repo.create({
      title: 'Seed Contract',
      clientId: CLIENT_ID,
      freelancerId: FREELANCER_ID,
      amount: 5_000,
    });
  }

  beforeEach(() => {
    repo = new InMemoryContractRepository();
  });

  // ── Parallel reads ──────────────────────────────────────────────────────

  describe('parallel reads', () => {
    it('all concurrent findById calls resolve to the same contract', async () => {
      const created = await seedContract();

      const results = await Promise.all(
        Array.from({ length: 20 }, () => repo.findById(created.id)),
      );

      for (const r of results) {
        expect(r).toBeDefined();
        expect(r!.id).toBe(created.id);
        expect(r!.version).toBe(0);
        expect(r!.title).toBe('Seed Contract');
      }
    });

    it('concurrent findAll calls all return the same stable list', async () => {
      await Promise.all([
        repo.create({ title: 'Alpha Contract', clientId: CLIENT_ID, freelancerId: FREELANCER_ID, amount: 1_000 }),
        repo.create({ title: 'Beta Contract',  clientId: CLIENT_ID, freelancerId: FREELANCER_ID, amount: 2_000 }),
        repo.create({ title: 'Gamma Contract', clientId: CLIENT_ID, freelancerId: FREELANCER_ID, amount: 3_000 }),
      ]);

      const pages = await Promise.all(
        Array.from({ length: 10 }, () => repo.findAll()),
      );

      const firstTitles = pages[0]!.map((c) => c.title).sort();
      for (const page of pages) {
        expect(page.map((c) => c.title).sort()).toEqual(firstTitles);
      }
    });
  });

  // ── Parallel creates ────────────────────────────────────────────────────

  describe('parallel creates', () => {
    it('N concurrent creates produce N unique IDs (no collisions)', async () => {
      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          repo.create({
            title: `Parallel Contract ${i + 1}`,
            clientId: CLIENT_ID,
            freelancerId: FREELANCER_ID,
            amount: 1_000 * (i + 1),
          }),
        ),
      );

      const ids = results.map((c) => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(N);
    });

    it('all contracts start at version 0', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.create({ title: `Version0 Contract ${i}`, clientId: CLIENT_ID, freelancerId: FREELANCER_ID, amount: 1_000 }),
        ),
      );

      for (const c of results) {
        expect(c.version).toBe(0);
      }
    });
  });

  // ── Parallel writes with same version (OCC conflict) ───────────────────

  describe('parallel writes — OCC version conflict', () => {
    it('exactly one writer wins; all others get VersionConflictError (N=5)', async () => {
      const contract = await seedContract();
      const WRITERS = 5;

      const results = await Promise.allSettled(
        Array.from({ length: WRITERS }, (_, i) =>
          repo.updateWithVersion(contract.id, { title: `Writer ${i} wins` }, 0),
        ),
      );

      const successes = results.filter((r) => r.status === 'fulfilled');
      const conflicts = results.filter(
        (r) => r.status === 'rejected' && (r.reason instanceof VersionConflictError),
      );

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(WRITERS - 1);
    });

    it('exactly one writer wins; all others get VersionConflictError (N=10)', async () => {
      const contract = await seedContract();
      const WRITERS = 10;

      const results = await Promise.allSettled(
        Array.from({ length: WRITERS }, (_, i) =>
          repo.updateWithVersion(contract.id, { title: `Writer ${i} title` }, 0),
        ),
      );

      const successes = results.filter((r) => r.status === 'fulfilled');
      const conflicts = results.filter(
        (r) => r.status === 'rejected' && (r.reason instanceof VersionConflictError),
      );

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(WRITERS - 1);
    });

    it('winning title is the only one persisted (no phantom writes)', async () => {
      const contract = await seedContract();
      const WRITERS = 6;
      let winnerTitle = '';

      const results = await Promise.allSettled(
        Array.from({ length: WRITERS }, (_, i) => {
          const title = `Concurrent Title ${i}`;
          return repo.updateWithVersion(contract.id, { title }, 0).then((c) => {
            winnerTitle = c.title;
            return c;
          });
        }),
      );

      const successes = results.filter((r) => r.status === 'fulfilled');
      expect(successes).toHaveLength(1);

      const persisted = await repo.findById(contract.id);
      expect(persisted!.title).toBe(winnerTitle);
      expect(persisted!.version).toBe(1);
    });
  });

  // ── Read-after-write consistency ────────────────────────────────────────

  describe('read-after-write', () => {
    it('a read immediately after a write reflects the new title', async () => {
      const contract = await seedContract();

      const updated = await repo.updateWithVersion(contract.id, { title: 'Post-Write Title' }, 0);
      const fetched = await repo.findById(contract.id);

      expect(updated.title).toBe('Post-Write Title');
      expect(fetched!.title).toBe('Post-Write Title');
      expect(fetched!.version).toBe(1);
    });

    it('concurrent read during write sees either old or new state — never corrupt', async () => {
      const contract = await seedContract();

      // Kick off a write and a read in parallel; the read must see a valid state.
      const [writeResult, readResult] = await Promise.all([
        repo.updateWithVersion(contract.id, { title: 'Atomic New Title' }, 0),
        repo.findById(contract.id),
      ]);

      // Write must succeed
      expect(writeResult.version).toBe(1);

      // Read is valid either way (old or new title, not undefined or corrupt)
      expect(readResult).toBeDefined();
      expect(typeof readResult!.title).toBe('string');
      expect(readResult!.title.length).toBeGreaterThan(0);
      expect(typeof readResult!.version).toBe('number');
    });
  });

  // ── No lost updates (sequential OCC chain) ──────────────────────────────

  describe('no lost updates — sequential OCC chain', () => {
    it('N sequential updates each with the latest version end at version N', async () => {
      const contract = await seedContract();
      const N = 8;
      let current = contract;

      for (let i = 0; i < N; i++) {
        current = await repo.updateWithVersion(
          current.id,
          { title: `Sequential Update ${i + 1}` },
          current.version,
        );
        expect(current.version).toBe(i + 1);
      }

      const final = await repo.findById(contract.id);
      expect(final!.version).toBe(N);
      expect(final!.title).toBe(`Sequential Update ${N}`);
    });

    it('version counter increments by exactly 1 per successful write', async () => {
      const contract = await seedContract();
      const STEPS = 5;
      let ver = 0;

      for (let i = 0; i < STEPS; i++) {
        const result = await repo.updateWithVersion(contract.id, { title: `Step ${i}` }, ver);
        expect(result.version).toBe(ver + 1);
        ver = result.version;
      }

      expect(ver).toBe(STEPS);
    });
  });

  // ── Parallel deletes ────────────────────────────────────────────────────

  describe('parallel deletes', () => {
    it('exactly one concurrent delete succeeds; the rest return false', async () => {
      const contract = await seedContract();
      const DELETERS = 5;

      const results = await Promise.all(
        Array.from({ length: DELETERS }, () => repo.delete(contract.id)),
      );

      const trueCount  = results.filter(Boolean).length;
      const falseCount = results.filter((r) => !r).length;

      expect(trueCount).toBe(1);
      expect(falseCount).toBe(DELETERS - 1);

      // Contract is gone
      expect(await repo.findById(contract.id)).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SQLite ContractRepository — atomic OCC concurrency
// ═══════════════════════════════════════════════════════════════════════════

describe('SQLite ContractRepository — concurrency smoke tests', () => {
  let repo: ContractRepository;
  let sqliteClientId: string;
  let sqliteFreelancerId: string;

  // Use getDb with a unique in-memory path so we get an isolated DB.
  // Uses the same shared :memory: singleton as the app (DB_PATH=:memory:).
  // Fresh UUIDs + unique emails per test avoid UNIQUE constraint failures
  // across repeated beforeEach calls on the shared DB.
  beforeEach(() => {
    const db = getDb(':memory:');
    repo = new ContractRepository(db);

    sqliteClientId    = randomUUID();
    sqliteFreelancerId = randomUUID();
    const tag = sqliteClientId.slice(0, 8);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(sqliteClientId, `sqcli-${tag}`, `sqcli-${tag}@test.com`, 'client', now);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(sqliteFreelancerId, `sqfrl-${tag}`, `sqfrl-${tag}@test.com`, 'freelancer', now);
  });

  async function seedSqliteContract() {
    return repo.create({
      title: 'SQLite Seed Contract',
      clientId: sqliteClientId,
      freelancerId: sqliteFreelancerId,
      amount: 7_500,
    });
  }

  // ── Parallel reads ──────────────────────────────────────────────────────

  describe('parallel reads', () => {
    it('all concurrent findById calls return the same row', async () => {
      const created = await seedSqliteContract();

      const results = await Promise.all(
        Array.from({ length: 15 }, () => repo.findById(created.id)),
      );

      for (const r of results) {
        expect(r).toBeDefined();
        expect(r!.id).toBe(created.id);
        expect(r!.version).toBe(0);
      }
    });

    it('concurrent findAll calls all agree on contract count', async () => {
      await Promise.all([
        repo.create({ title: 'Foo', clientId: sqliteClientId, freelancerId: sqliteFreelancerId, amount: 1_000 }),
        repo.create({ title: 'Bar', clientId: sqliteClientId, freelancerId: sqliteFreelancerId, amount: 2_000 }),
      ]);

      const pages = await Promise.all(
        Array.from({ length: 10 }, () => repo.findAll()),
      );

      for (const page of pages) {
        expect(page).toHaveLength(2);
      }
    });
  });

  // ── Parallel writes — atomic SQL OCC ────────────────────────────────────

  describe('parallel writes — atomic SQL OCC', () => {
    it('exactly one writer wins; all others throw VersionConflictError (N=5)', async () => {
      const contract = await seedSqliteContract();
      const WRITERS = 5;

      const results = await Promise.allSettled(
        Array.from({ length: WRITERS }, (_, i) =>
          repo.updateWithVersion(contract.id, { title: `SQL Writer ${i}` }, 0),
        ),
      );

      const successes = results.filter((r) => r.status === 'fulfilled');
      const conflicts = results.filter(
        (r) => r.status === 'rejected' && (r.reason instanceof VersionConflictError),
      );

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(WRITERS - 1);
    });

    it('persisted version is exactly 1 after one concurrent winner', async () => {
      const contract = await seedSqliteContract();

      await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          repo.updateWithVersion(contract.id, { title: `Concurrent SQL ${i}` }, 0),
        ),
      );

      const final = await repo.findById(contract.id);
      expect(final!.version).toBe(1);
    });

    it('no lost updates: N sequential updates reach version N', async () => {
      const contract = await seedSqliteContract();
      const N = 6;
      let current = contract;

      for (let i = 0; i < N; i++) {
        current = await repo.updateWithVersion(
          current.id,
          { title: `SQL Sequential ${i + 1}` },
          current.version,
        );
      }

      const final = await repo.findById(contract.id);
      expect(final!.version).toBe(N);
    });
  });

  // ── Read-after-write consistency ────────────────────────────────────────

  describe('read-after-write', () => {
    it('read immediately after write reflects the new state', async () => {
      const contract = await seedSqliteContract();

      await repo.updateWithVersion(contract.id, { title: 'SQL Post-Write' }, 0);
      const fetched = await repo.findById(contract.id);

      expect(fetched!.title).toBe('SQL Post-Write');
      expect(fetched!.version).toBe(1);
    });
  });

  // ── Parallel creates ────────────────────────────────────────────────────

  describe('parallel creates', () => {
    it('N concurrent creates produce N unique IDs', async () => {
      const N = 15;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          repo.create({
            title: `Parallel SQL Contract ${i}`,
            clientId: sqliteClientId,
            freelancerId: sqliteFreelancerId,
            amount: 500 * (i + 1),
          }),
        ),
      );

      const ids = results.map((c) => c.id);
      expect(new Set(ids).size).toBe(N);

      const all = await repo.findAll();
      expect(all).toHaveLength(N);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ContractsService — OCC concurrency through the service layer
// ═══════════════════════════════════════════════════════════════════════════

describe('ContractsService — concurrency smoke tests', () => {
  let service: ContractsService;
  let inMemRepo: InMemoryContractRepository;

  beforeEach(() => {
    inMemRepo = new InMemoryContractRepository();
    service = new ContractsService(inMemRepo);
  });

  async function seedServiceContract() {
    return service.createContract({
      title: 'Service Seed Contract',
      clientId: CLIENT_ID,
      freelancerId: FREELANCER_ID,
      budget: 8_000,
      status: 'draft',
    });
  }

  // ── Parallel updateContract calls ────────────────────────────────────────

  describe('parallel updateContract calls', () => {
    it('exactly one writer wins; all others throw VersionConflictError (N=5)', async () => {
      const contract = await seedServiceContract();
      const WRITERS = 5;

      const results = await Promise.allSettled(
        Array.from({ length: WRITERS }, (_, i) =>
          service.updateContract(contract.id, {
            version: 0,
            title: `Service Writer ${i} wins`,
          }),
        ),
      );

      const successes = results.filter((r) => r.status === 'fulfilled');
      const conflicts = results.filter(
        (r) => r.status === 'rejected' && (r.reason instanceof VersionConflictError),
      );

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(WRITERS - 1);
    });

    it('persisted version is 1 after one winner from 10 concurrent writers', async () => {
      const contract = await seedServiceContract();

      await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          service.updateContract(contract.id, { version: 0, title: `Svc concurrent ${i}` }),
        ),
      );

      const final = await service.getContractById(contract.id);
      expect(final!.version).toBe(1);
    });

    it('winner title is persisted; losers do not overwrite it', async () => {
      const contract = await seedServiceContract();
      let winnerTitle = '';

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => {
          const title = `Svc Winner Title ${i} ABCDEFGH`;
          return service
            .updateContract(contract.id, { version: 0, title })
            .then((c) => {
              winnerTitle = c.title;
              return c;
            });
        }),
      );

      const successes = results.filter((r) => r.status === 'fulfilled');
      expect(successes).toHaveLength(1);

      const persisted = await service.getContractById(contract.id);
      expect(persisted!.title).toBe(winnerTitle);
    });
  });

  // ── Sequential OCC chain through service layer ───────────────────────────

  describe('sequential OCC chain through service', () => {
    it('N sequential updates each reading latest version end at version N', async () => {
      const contract = await seedServiceContract();
      const N = 5;
      let currentVersion = contract.version;

      for (let i = 0; i < N; i++) {
        const updated = await service.updateContract(contract.id, {
          version: currentVersion,
          title: `Svc Sequential ${i + 1}`,
        });
        expect(updated.version).toBe(currentVersion + 1);
        currentVersion = updated.version;
      }

      const final = await service.getContractById(contract.id);
      expect(final!.version).toBe(N);
      expect(final!.title).toBe(`Svc Sequential ${N}`);
    });
  });

  // ── Parallel getAllContracts ──────────────────────────────────────────────

  describe('parallel getAllContracts', () => {
    it('all concurrent getAll calls return the same list', async () => {
      await Promise.all([
        seedServiceContract(),
        seedServiceContract(),
        seedServiceContract(),
      ]);

      const lists = await Promise.all(
        Array.from({ length: 8 }, () => service.getAllContracts()),
      );

      for (const list of lists) {
        expect(list).toHaveLength(3);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. HTTP layer — end-to-end concurrency smoke tests
// ═══════════════════════════════════════════════════════════════════════════

describe('HTTP layer — concurrency smoke tests', () => {
  // ── Parallel reads via GET /api/v1/contracts ─────────────────────────────

  describe('GET /api/v1/contracts — parallel reads', () => {
    it('N concurrent GET requests all return 200 with consistent data', async () => {
      // Seed two contracts first
      await createContractViaHttp();
      await createContractViaHttp();

      const N = 15;
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          request(app)
            .get('/api/v1/contracts')
            .set(authHeader(adminToken())),
        ),
      );

      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
      }

      // All responses must agree on the contract count
      const counts = results.map((r) => {
        // offset-paginated response has data array; cursor response has data.data
        const d = r.body.data;
        return Array.isArray(d) ? d.length : (Array.isArray(d?.data) ? d.data.length : -1);
      });
      expect(new Set(counts).size).toBe(1);
    });

    it('concurrent GET requests return non-corrupt response envelopes', async () => {
      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          request(app)
            .get('/api/v1/contracts')
            .set(authHeader(adminToken())),
        ),
      );

      for (const res of results) {
        expect(res.status).toBe(200);
        expect(typeof res.body).toBe('object');
        expect(res.body).not.toBeNull();
        // Must have a requestId in the response envelope
        expect(typeof res.body.requestId).toBe('string');
      }
    });
  });

  // ── Parallel GET /:id ─────────────────────────────────────────────────────

  describe('GET /api/v1/contracts/:id — parallel reads by ID', () => {
    it('N concurrent single-contract reads all return 200 with the same data', async () => {
      const { id } = await createContractViaHttp();

      const N = 15;
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          request(app)
            .get(`/api/v1/contracts/${id}`)
            .set(authHeader(adminToken())),
        ),
      );

      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe(id);
        expect(res.body.data.version).toBe(0);
      }
    });
  });

  // ── Parallel PATCH — OCC version conflict ────────────────────────────────

  describe('PATCH /api/v1/contracts/:id — parallel writes OCC', () => {
    it('N concurrent PATCHes with the same version: exactly one 200, rest are 409', async () => {
      const { id } = await createContractViaHttp();
      const WRITERS = 8;

      const results = await Promise.all(
        Array.from({ length: WRITERS }, (_, i) =>
          request(app)
            .patch(`/api/v1/contracts/${id}`)
            .set(authHeader(adminToken()))
            .send({ version: 0, title: `HTTP Concurrent Writer ${i} Title` }),
        ),
      );

      const statuses = results.map((r) => r.status);
      const successCount  = statuses.filter((s) => s === 200).length;
      const conflictCount = statuses.filter((s) => s === 409).length;

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(WRITERS - 1);
    });

    it('conflict responses carry the ERR_CONFLICT code', async () => {
      const { id } = await createContractViaHttp();

      const results = await Promise.all([
        request(app).patch(`/api/v1/contracts/${id}`).set(authHeader(adminToken())).send({ version: 0, title: 'HTTP Title Alpha AAAAA' }),
        request(app).patch(`/api/v1/contracts/${id}`).set(authHeader(adminToken())).send({ version: 0, title: 'HTTP Title Beta BBBBB' }),
        request(app).patch(`/api/v1/contracts/${id}`).set(authHeader(adminToken())).send({ version: 0, title: 'HTTP Title Gamma CCCCC' }),
      ]);

      const conflictResponses = results.filter((r) => r.status === 409);
      for (const res of conflictResponses) {
        expect(res.body.error.code).toBe('ERR_CONFLICT');
      }
    });

    it('version is exactly 1 after one winner from N concurrent PATCHes', async () => {
      const { id } = await createContractViaHttp();

      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request(app)
            .patch(`/api/v1/contracts/${id}`)
            .set(authHeader(adminToken()))
            .send({ version: 0, title: `Fan-Out PATCH Writer ${i}` }),
        ),
      );

      const getRes = await request(app)
        .get(`/api/v1/contracts/${id}`)
        .set(authHeader(adminToken()));

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.version).toBe(1);
    });
  });

  // ── Read-after-write (HTTP) ──────────────────────────────────────────────

  describe('read-after-write — HTTP', () => {
    it('GET immediately after PATCH reflects the updated title', async () => {
      const { id } = await createContractViaHttp();

      const patchRes = await request(app)
        .patch(`/api/v1/contracts/${id}`)
        .set(authHeader(adminToken()))
        .send({ version: 0, title: 'HTTP Post-Write Title' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.version).toBe(1);

      const getRes = await request(app)
        .get(`/api/v1/contracts/${id}`)
        .set(authHeader(adminToken()));

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.title).toBe('HTTP Post-Write Title');
      expect(getRes.body.data.version).toBe(1);
    });

    it('concurrent read + write: read sees a valid state', async () => {
      const { id } = await createContractViaHttp();

      const [patchRes, getRes] = await Promise.all([
        request(app)
          .patch(`/api/v1/contracts/${id}`)
          .set(authHeader(adminToken()))
          .send({ version: 0, title: 'Concurrent HTTP Write Title' }),
        request(app)
          .get(`/api/v1/contracts/${id}`)
          .set(authHeader(adminToken())),
      ]);

      // PATCH must succeed
      expect(patchRes.status).toBe(200);

      // GET is valid regardless of whether it raced before or after the write
      expect(getRes.status).toBe(200);
      expect(typeof getRes.body.data.title).toBe('string');
      expect([0, 1]).toContain(getRes.body.data.version);
    });
  });

  // ── Sequential OCC chain (HTTP) ──────────────────────────────────────────

  describe('sequential OCC chain — HTTP', () => {
    it('N sequential PATCHes each reading the current version reach version N', async () => {
      const { id } = await createContractViaHttp();
      const N = 5;
      let currentVersion = 0;

      for (let i = 0; i < N; i++) {
        const res = await request(app)
          .patch(`/api/v1/contracts/${id}`)
          .set(authHeader(adminToken()))
          .send({ version: currentVersion, title: `HTTP Sequential Step ${i + 1}` });

        expect(res.status).toBe(200);
        expect(res.body.data.version).toBe(currentVersion + 1);
        currentVersion = res.body.data.version;
      }

      const getRes = await request(app)
        .get(`/api/v1/contracts/${id}`)
        .set(authHeader(adminToken()));

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.version).toBe(N);
    });
  });

  // ── Parallel POST creates ─────────────────────────────────────────────────

  describe('POST /api/v1/contracts — parallel creates', () => {
    it('N concurrent POSTs produce N distinct contracts with unique IDs', async () => {
      const N = 10;

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          request(app)
            .post('/api/v1/contracts')
            .set({ ...authHeader(adminToken()), 'Idempotency-Key': randomUUID() })
            .send(validPayload),
        ),
      );

      for (const res of results) {
        expect(res.status).toBe(201);
      }

      const ids = results.map((r) => r.body.data.id as string);
      expect(new Set(ids).size).toBe(N);
    });
  });

  // ── Parallel DELETEs ─────────────────────────────────────────────────────

  describe('DELETE /api/v1/contracts/:id — parallel deletes', () => {
    it('exactly one concurrent DELETE succeeds; the rest get 404', async () => {
      const { id } = await createContractViaHttp();
      const DELETERS = 5;

      const results = await Promise.all(
        Array.from({ length: DELETERS }, () =>
          request(app)
            .delete(`/api/v1/contracts/${id}`)
            .set(authHeader(adminToken())),
        ),
      );

      const statuses = results.map((r) => r.status);
      const successCount = statuses.filter((s) => s === 200).length;
      const notFoundCount = statuses.filter((s) => s === 404).length;

      expect(successCount).toBe(1);
      expect(notFoundCount).toBe(DELETERS - 1);
    });
  });
});
