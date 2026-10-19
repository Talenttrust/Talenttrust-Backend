import { EscrowRepository } from '../src/repo/types';
import { EscrowContract } from '../src/domain';

const contract = (id: number): EscrowContract => ({ id, title: 'Project', client: 'GA', freelancer: 'GB', token: 'XLM',
  milestones: [{ index: 0, title: 'One', amount: 100, released: false }], totalAmount: 100,
  fundedAmount: 0, releasedAmount: 0, status: 'Created', reputationIssued: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

/** The same behavioral contract runs unchanged against every adapter. */
export function repositoryContract(factory: () => EscrowRepository) {
  let repo: EscrowRepository;
  beforeEach(() => { repo = factory(); });
  afterEach(async () => { await repo.close(); });

  it('allocates unique IDs concurrently and reserves inserted IDs', async () => {
    expect(await Promise.all(Array.from({ length: 20 }, () => repo.nextId()))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await repo.insert(contract(40));
    expect(await repo.nextId()).toBe(41);
  });

  it('returns missing rows and detached reads, writes and lists', async () => {
    expect(await repo.get(1)).toBeUndefined();
    expect(await repo.list()).toEqual([]);
    const c = contract(1);
    await repo.insert(c);
    c.milestones[0].amount = 999;
    const copy = (await repo.get(1))!;
    expect(copy.milestones[0].amount).toBe(100);
    copy.milestones[0].released = true;
    (await repo.list())[0].milestones[0].title = 'changed';
    expect(await repo.get(1)).toEqual(contract(1));
    await expect(repo.insert(contract(1))).rejects.toMatchObject({ status: 409, code: 'duplicate_contract' });
  });

  it('filters by status and either party, combines filters, and orders by ID', async () => {
    await repo.insert({ ...contract(2), status: 'Funded', client: 'GC', freelancer: 'GA' });
    await repo.insert(contract(1));
    expect((await repo.list()).map(c => c.id)).toEqual([1, 2]);
    expect((await repo.list({ party: 'GA' })).map(c => c.id)).toEqual([1, 2]);
    expect((await repo.list({ party: 'GA', status: 'Funded' })).map(c => c.id)).toEqual([2]);
    expect(await repo.list({ party: "' OR 1=1 --" })).toEqual([]);
    expect(await repo.list({ status: 'unknown' })).toEqual([]);
  });

  it('updates full JSON and rejects stale or missing updates without overwriting', async () => {
    const c = contract(1);
    await repo.insert(c);
    const changed = { ...c, status: 'Disputed' as const, client: 'GX', updatedAt: '2026-01-02T00:00:00.000Z',
      dispute: { raisedBy: 'GB', reason: "can't agree", openedAt: c.createdAt } };
    await repo.update(changed, c.updatedAt);
    expect(await repo.get(1)).toEqual(changed);
    await expect(repo.update(c, c.updatedAt)).rejects.toMatchObject({ code: 'write_conflict' });
    await expect(repo.update(contract(99), c.updatedAt)).rejects.toMatchObject({ code: 'write_conflict' });
    expect(await repo.get(1)).toEqual(changed);
    expect(await repo.list({ party: 'GA' })).toEqual([]);
    expect(await repo.list({ party: 'GX', status: 'Disputed' })).toEqual([changed]);
  });

  it('upserts additive reputation with rounded averages and literal addresses', async () => {
    const address = "G'; DROP TABLE reputation; --";
    expect(await repo.getReputation(address)).toEqual({ address, completedContracts: 0, totalRating: 0, averageRating: 0 });
    await repo.upsertReputation(address, { completedContracts: 1, totalRating: 5 });
    await repo.upsertReputation(address, { completedContracts: 2, totalRating: 8 });
    const value = await repo.getReputation(address);
    expect(value).toEqual({ address, completedContracts: 3, totalRating: 13, averageRating: 4.33 });
    value.totalRating = 0;
    expect((await repo.getReputation(address)).totalRating).toBe(13);
  });

  it('commits callback results and rolls back IDs, rows and reputation after an await', async () => {
    expect(await repo.transaction(async () => { await repo.insert(contract(await repo.nextId())); return 'committed'; })).toBe('committed');
    await expect(repo.transaction(async () => {
      await repo.insert(contract(await repo.nextId()));
      await repo.update({ ...contract(1), fundedAmount: 50 }, contract(1).updatedAt);
      await repo.upsertReputation('GB', { completedContracts: 1, totalRating: 5 });
      await Promise.resolve();
      throw new Error('injected');
    })).rejects.toThrow('injected');
    expect(await repo.list()).toEqual([contract(1)]);
    expect((await repo.getReputation('GB')).totalRating).toBe(0);
    expect(await repo.nextId()).toBe(2);
  });

  it('isolates unrelated operations while a transaction awaits and recovers after rollback', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    const pending = repo.transaction(async () => { await repo.insert(contract(1)); entered(); await gate; throw new Error('rollback'); });
    const rejection = expect(pending).rejects.toThrow('rollback');
    await started;
    const read = repo.get(1);
    const write = repo.insert(contract(2));
    release();
    await rejection;
    expect(await read).toBeUndefined();
    await write;
    expect(await repo.list()).toEqual([contract(2)]);
  });

  it('rolls back the outer transaction even when a nested failure is caught', async () => {
    await expect(repo.transaction(async () => {
      await repo.insert(contract(1));
      await repo.transaction(async () => { throw new Error('nested'); }).catch(() => undefined);
    })).rejects.toThrow('nested');
    expect(await repo.list()).toEqual([]);
  });

  it('closes idempotently and rejects access after closing', async () => {
    await repo.close();
    await repo.close();
    await expect(repo.get(1)).rejects.toThrow('closed');
  });
}
