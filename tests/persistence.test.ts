import fs from 'fs';
import os from 'os';
import path from 'path';
import { EscrowStore } from '../src/store';
import {
  SNAPSHOT_SCHEMA_VERSION,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  serializeStore,
  restoreStore,
  writeSnapshotAtomic,
  loadSnapshotFile,
  parseSnapshotIntervalMs,
  startSnapshotPersistence,
} from '../src/persistence';

const CLIENT_A = 'GCLIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CLIENT_B = 'GCLIENTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const FREELANCER_A = 'GFREELANCERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FREELANCER_B = 'GFREELANCERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const TOKEN = 'CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const BIG_AMOUNT_1 = '9007199254740993'; // 2^53 + 1
const BIG_AMOUNT_2 = '123456789012345678901234'; // well above 2^53
const BIG_TOTAL = (BigInt(BIG_AMOUNT_1) + BigInt(BIG_AMOUNT_2)).toString();

function buildPopulatedStore(): EscrowStore {
  let tick = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date((tick += 60_000));
  const store = new EscrowStore(clock);

  // Templates (fixed with bigint > 2^53 and percent)
  const fixedTpl = store.createTemplate({
    owner: CLIENT_A,
    name: 'Large Fixed Template',
    description: 'Uses amounts above 2^53',
    mode: 'fixed',
    milestones: [
      { title: 'Phase 1', amount: BIG_AMOUNT_1 },
      { title: 'Phase 2', amount: BIG_AMOUNT_2 },
    ],
  });
  store.updateTemplate(fixedTpl.id, CLIENT_A, {
    name: 'Large Fixed Template v2',
    milestones: [
      { title: 'Phase 1', amount: BIG_AMOUNT_1 },
      { title: 'Phase 2', amount: BIG_AMOUNT_2 },
    ],
  });

  store.createTemplate({
    owner: CLIENT_B,
    name: 'Percent Split',
    mode: 'percent',
    milestones: [
      { title: 'Kickoff', percentBps: 4000 },
      { title: 'Delivery', percentBps: 6000 },
    ],
  });

  // Contract 1: edited (revision history), funded with bigint > 2^53, completed, reviewed both ways
  const c1 = store.create({
    title: 'Initial Title',
    client: CLIENT_A,
    freelancer: FREELANCER_A,
    token: TOKEN,
    milestones: [
      { title: 'M1', amount: BIG_AMOUNT_1 },
      { title: 'M2', amount: BIG_AMOUNT_2 },
    ],
  });
  store.edit(c1.id, {
    client: CLIENT_A,
    title: 'Updated High-Value Contract',
  });
  store.deposit(c1.id, BIG_TOTAL);
  store.release(c1.id, 0);
  store.release(c1.id, 1);
  store.createReview(c1.id, { reviewer: CLIENT_A, rating: 5, comment: 'Great work' });
  store.createReview(c1.id, { reviewer: FREELANCER_A, rating: 4, comment: 'Smooth client' });

  // Contract 2: disputed and resolved
  const c2 = store.create({
    title: 'Disputed Engagement',
    client: CLIENT_B,
    freelancer: FREELANCER_B,
    token: TOKEN,
    milestones: [{ title: 'Audit', amount: 500_000 }],
  });
  store.deposit(c2.id, 500_000);
  store.openDispute(c2.id, CLIENT_B, 'Incomplete deliverable');
  store.resolveDispute(c2.id, 6000, 'ops-1');
  store.createReview(c2.id, { reviewer: CLIENT_B, rating: 3, comment: 'Resolved fairly' });

  // Contract 3: cancelled
  const c3 = store.create({
    title: 'Cancelled Contract',
    client: CLIENT_A,
    freelancer: FREELANCER_B,
    token: TOKEN,
    milestones: [{ title: 'Prototype', amount: 100_000 }],
  });
  store.cancel(c3.id);

  return store;
}

describe('store snapshot persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talenttrust-snapshot-'));
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('round-trips contracts, revisions, templates, reputation, reviews, bigints > 2^53, counters, and audit chain', () => {
    const source = buildPopulatedStore();
    expect(source.audit.verify().valid).toBe(true);

    // Serialize and pass through JSON to ensure pure JSON compatibility
    const snapshot = JSON.parse(JSON.stringify(serializeStore(source)));
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);

    const restored = new EscrowStore();
    restoreStore(restored, snapshot);

    // Contracts & revisions
    expect(restored.list()).toEqual(source.list());
    const restoredC1 = restored.get(1);
    expect(restoredC1.totalAmountUnits).toBe(BIG_TOTAL);
    expect(restoredC1.fundedAmountUnits).toBe(BIG_TOTAL);
    expect(restoredC1.releasedAmountUnits).toBe(BIG_TOTAL);
    expect(restoredC1.milestones[0].amountUnits).toBe(BIG_AMOUNT_1);
    expect(restoredC1.milestones[1].amountUnits).toBe(BIG_AMOUNT_2);
    expect(restored.getRevisions(1)).toEqual(source.getRevisions(1));

    // Templates
    expect(restored.listTemplates({ owner: CLIENT_A })).toEqual(source.listTemplates({ owner: CLIENT_A }));
    expect(restored.listTemplates({ owner: CLIENT_B })).toEqual(source.listTemplates({ owner: CLIENT_B }));
    expect(restored.getTemplate(1).milestones[0].amountUnits).toBe(BIG_AMOUNT_1);
    expect(restored.getTemplate(1).milestones[1].amountUnits).toBe(BIG_AMOUNT_2);

    // Reputation & reviews
    expect(restored.getReputation(FREELANCER_A)).toEqual(source.getReputation(FREELANCER_A));
    expect(restored.getReputation(FREELANCER_B)).toEqual(source.getReputation(FREELANCER_B));
    expect(restored.getReputationWithClient(CLIENT_A)).toEqual(source.getReputationWithClient(CLIENT_A));
    expect(restored.listReviews(FREELANCER_A)).toEqual(source.listReviews(FREELANCER_A));
    expect(restored.listReviews(CLIENT_A)).toEqual(source.listReviews(CLIENT_A));

    // Audit chain verifies and histories match
    const verify = restored.audit.verify();
    expect(verify.valid).toBe(true);
    expect(verify.entries).toBe(source.audit.verify().entries);
    expect(restored.audit.getContractHistory(1)).toEqual(source.audit.getContractHistory(1));
    expect(restored.audit.getContractHistory(2)).toEqual(source.audit.getContractHistory(2));
    expect(restored.audit.getContractHistory(3)).toEqual(source.audit.getContractHistory(3));

    // Counters are preserved and further mutations keep audit chain valid
    const nextContract = restored.create({
      title: 'Post-restore contract',
      client: CLIENT_A,
      freelancer: FREELANCER_A,
      token: TOKEN,
      milestones: [{ title: 'M1', amount: 1000 }],
    });
    expect(nextContract.id).toBe(4);
    expect(restored.audit.verify().valid).toBe(true);

    const nextTemplate = restored.createTemplate({
      owner: CLIENT_A,
      name: 'Post-restore template',
      mode: 'fixed',
      milestones: [{ title: 'M1', amount: 500 }],
    });
    expect(nextTemplate.id).toBe(3);
  });

  test('writes atomically without leftover temp files and loads back from disk', () => {
    const filePath = path.join(tmpDir, 'nested', 'store.json');
    const source = buildPopulatedStore();

    writeSnapshotAtomic(filePath, source);

    const dirEntries = fs.readdirSync(path.dirname(filePath));
    expect(dirEntries).toEqual(['store.json']);

    const restored = new EscrowStore();
    expect(loadSnapshotFile(filePath, restored)).toBe(true);
    expect(restored.list()).toEqual(source.list());
    expect(restored.audit.verify().valid).toBe(true);
  });

  test('returns false when snapshot file does not exist', () => {
    const filePath = path.join(tmpDir, 'does-not-exist.json');
    const store = new EscrowStore();
    expect(loadSnapshotFile(filePath, store)).toBe(false);
  });

  test('aborts with a clear error on corrupt JSON, tampered audit chain, or newer schemaVersion', () => {
    const store = new EscrowStore();

    // Corrupt JSON
    const corruptPath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{not-valid-json', 'utf8');
    expect(() => loadSnapshotFile(corruptPath, store)).toThrow(/Corrupt snapshot file.*invalid JSON/i);

    // Newer schemaVersion
    const source = buildPopulatedStore();
    const newerSnapshot = { ...serializeStore(source), schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 };
    const newerPath = path.join(tmpDir, 'newer.json');
    fs.writeFileSync(newerPath, JSON.stringify(newerSnapshot), 'utf8');
    expect(() => loadSnapshotFile(newerPath, store)).toThrow(/Unsupported snapshot schemaVersion/i);

    // Tampered audit chain
    const tampered = serializeStore(source);
    tampered.audit.entries[0].action = 'cancel';
    const tamperedPath = path.join(tmpDir, 'tampered.json');
    fs.writeFileSync(tamperedPath, JSON.stringify(tampered), 'utf8');
    expect(() => loadSnapshotFile(tamperedPath, store)).toThrow(/audit hash chain verification failed/i);
  });

  test('flushes on configured interval and on graceful shutdown (fake timers)', () => {
    jest.useFakeTimers();

    const filePath = path.join(tmpDir, 'periodic.json');
    const store = new EscrowStore();
    const controller = startSnapshotPersistence(store, {
      filePath,
      intervalMs: 5_000,
    });

    // No file written yet before first interval
    expect(fs.existsSync(filePath)).toBe(false);

    store.create({
      title: 'Before first tick',
      client: CLIENT_A,
      freelancer: FREELANCER_A,
      token: TOKEN,
      milestones: [{ title: 'M1', amount: 100 }],
    });

    jest.advanceTimersByTime(5_000);
    expect(fs.existsSync(filePath)).toBe(true);

    const afterTick = new EscrowStore();
    loadSnapshotFile(filePath, afterTick);
    expect(afterTick.list().map((c) => c.title)).toEqual(['Before first tick']);

    // Mutate again, then trigger graceful shutdown flush before next interval
    store.create({
      title: 'Before shutdown',
      client: CLIENT_A,
      freelancer: FREELANCER_A,
      token: TOKEN,
      milestones: [{ title: 'M1', amount: 200 }],
    });

    controller.stop();

    const afterShutdown = new EscrowStore();
    loadSnapshotFile(filePath, afterShutdown);
    expect(afterShutdown.list().map((c) => c.title)).toEqual(['Before first tick', 'Before shutdown']);
    expect(afterShutdown.audit.verify().valid).toBe(true);
  });

  test('parseSnapshotIntervalMs defaults to 30000 and rejects invalid values', () => {
    expect(parseSnapshotIntervalMs(undefined)).toBe(DEFAULT_SNAPSHOT_INTERVAL_MS);
    expect(parseSnapshotIntervalMs('')).toBe(DEFAULT_SNAPSHOT_INTERVAL_MS);
    expect(parseSnapshotIntervalMs('15000')).toBe(15000);
    expect(() => parseSnapshotIntervalMs('0')).toThrow(/Invalid STORE_SNAPSHOT_INTERVAL_MS/);
    expect(() => parseSnapshotIntervalMs('-5')).toThrow(/Invalid STORE_SNAPSHOT_INTERVAL_MS/);
    expect(() => parseSnapshotIntervalMs('abc')).toThrow(/Invalid STORE_SNAPSHOT_INTERVAL_MS/);
  });
});
