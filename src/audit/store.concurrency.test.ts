/**
 * @file store.concurrency.test.ts
 * @description Regression coverage for the write-side concurrency contract of
 * `AuditStore` (issue #1379): concurrent or repeated appends must not fork or
 * gap the hash chain, a re-entrant write must be rejected without leaving
 * partial state, and a failed batch append must be all-or-nothing.
 */

import {
  AuditStore,
  AuditStoreConcurrencyError,
  GENESIS_HASH,
  computeEntryHash,
} from './store';
import type { AuditEntry, CreateAuditEntryInput } from './types';

const input = (overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput => ({
  action: 'CONTRACT_CREATED',
  severity: 'INFO',
  actor: 'user-1',
  resource: 'contract',
  resourceId: 'contract-1',
  metadata: {},
  ...overrides,
});

/** Asserts the whole log is a single, gap-free, untampered hash chain. */
function expectIntactChain(entries: AuditEntry[]): void {
  expect(entries.length).toBeGreaterThan(0);
  entries.forEach((entry, index) => {
    const expectedPrev = index === 0 ? GENESIS_HASH : entries[index - 1].hash;
    expect(entry.previousHash).toBe(expectedPrev);
    const { hash, ...rest } = entry;
    expect(computeEntryHash(rest)).toBe(hash);
  });
}

describe('AuditStore — concurrent writes', () => {
  it('interleaved appends from concurrent async callers produce one intact chain', async () => {
    const store = new AuditStore();

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => store.append(input({ resourceId: `c${i}` }))),
      ),
    );

    const entries = store.getAll();
    expect(entries).toHaveLength(50);
    expect(new Set(entries.map((e) => e.id)).size).toBe(50);
    expect(new Set(entries.map((e) => e.hash)).size).toBe(50);
    expectIntactChain(entries);
    expect(store.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 50 });
  });

  it('interleaved appendMany batches are applied atomically and stay chained', async () => {
    const store = new AuditStore();

    await Promise.all([
      Promise.resolve().then(() => store.appendMany([input({ resourceId: 'a1' }), input({ resourceId: 'a2' })])),
      Promise.resolve().then(() => store.append(input({ resourceId: 'single' }))),
      Promise.resolve().then(() => store.appendMany([input({ resourceId: 'b1' }), input({ resourceId: 'b2' }), input({ resourceId: 'b3' })])),
    ]);

    const entries = store.getAll();
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.resourceId).sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'b3', 'single']);
    expectIntactChain(entries);
    expect(store.verifyIntegrity().valid).toBe(true);
  });

  it('rapid appends within the same millisecond still get unique ids and a valid chain', () => {
    const store = new AuditStore();
    const ids = new Set<string>();

    for (let i = 0; i < 200; i += 1) {
      ids.add(store.append(input({ resourceId: `c${i}` })).id);
    }

    expect(ids.size).toBe(200);
    expect(store.count()).toBe(200);
    expect(store.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 200 });
  });

  it('retrying the same logical write is safe: the append-only log stays consistent', () => {
    const store = new AuditStore();
    const sameInput = input({ resourceId: 'retry-me' });

    const first = store.append(sameInput);
    const retry = store.append(sameInput);

    // Retries are not silently deduplicated at the store layer, but they are
    // safe: distinct entries, one unbroken chain.
    expect(retry.id).not.toBe(first.id);
    expect(store.count()).toBe(2);
    expectIntactChain(store.getAll());
  });
});

describe('AuditStore — re-entrant writes', () => {
  it('rejects a nested write with a typed error and leaves the log untouched', () => {
    const store = new AuditStore();

    const reentrant = input({
      resourceId: 'outer',
      metadata: {
        get nested(): number {
          store.append(input({ resourceId: 'inner' }));
          return 1;
        },
      },
    });

    expect(() => store.append(reentrant)).toThrow(AuditStoreConcurrencyError);
    expect(store.count()).toBe(0);
    expect(store.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 0 });
  });

  it('exposes a stable machine-readable code on the error', () => {
    const store = new AuditStore();
    let caught: unknown;

    try {
      store.append(
        input({
          metadata: {
            get nested(): number {
              store.append(input());
              return 1;
            },
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuditStoreConcurrencyError);
    expect((caught as AuditStoreConcurrencyError).code).toBe('audit_store_concurrency_violation');
  });

  it('remains usable after a rejected re-entrant write', () => {
    const store = new AuditStore();

    expect(() =>
      store.append(
        input({
          metadata: {
            get nested(): number {
              store.append(input());
              return 1;
            },
          },
        }),
      ),
    ).toThrow(AuditStoreConcurrencyError);

    const ok = store.append(input({ resourceId: 'after' }));
    expect(store.count()).toBe(1);
    expect(store.getById(ok.id)).toBeDefined();
    expect(store.verifyIntegrity().valid).toBe(true);
  });
});

describe('AuditStore — partial failure is all-or-nothing', () => {
  it('appendMany rolls back the whole batch when a later entry fails to build', () => {
    const store = new AuditStore();

    const badMetadata = {
      toJSON(): never {
        throw new Error('simulated hashing failure');
      },
    };

    expect(() =>
      store.appendMany([
        input({ resourceId: 'ok-1' }),
        input({ resourceId: 'bad', metadata: badMetadata as unknown as Record<string, unknown> }),
        input({ resourceId: 'ok-2' }),
      ]),
    ).toThrow('simulated hashing failure');

    expect(store.count()).toBe(0);
    expect(store.getAll()).toEqual([]);
    expect(store.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 0 });
  });

  it('a failed appendMany does not disturb a pre-existing chain', () => {
    const store = new AuditStore();
    const existing = store.append(input({ resourceId: 'before' }));

    expect(() =>
      store.appendMany([
        input({ resourceId: 'would-be-1' }),
        input({
          resourceId: 'bad',
          metadata: {
            toJSON(): never {
              throw new Error('boom');
            },
          } as unknown as Record<string, unknown>,
        }),
      ]),
    ).toThrow('boom');

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(existing.id);
    expectIntactChain(entries);
  });

  it('appendMany([]) is a no-op', () => {
    const store = new AuditStore();
    expect(store.appendMany([])).toEqual([]);
    expect(store.count()).toBe(0);
  });
});
