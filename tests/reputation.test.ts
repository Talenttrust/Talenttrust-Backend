import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore, Reputation } from '../src/store';
import { account } from './helpers/addresses';

function addCompletedRatedJob(store: EscrowStore, client: string, freelancer: string, rating: number) {
  const c = store.create({ client, freelancer, milestones: [{ amount: 100 }] });
  store.deposit(c.id, 100);
  store.release(c.id, 0);
  return store.rate(c.id, rating);
}

describe('Reputation leaderboard, Bayesian ranking, and rating histogram', () => {
  it('ranks B (20 jobs avg 4.8) above A (1 job, 5★) by score, and A above B by average', async () => {
    const store = new EscrowStore({ priorWeight: 5 });
    const app = createApp(store);

    // Baseline freelancer C to anchor global mean around typical ratings
    for (let i = 0; i < 9; i++) {
      addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_C'), 3);
    }

    // Freelancer A: 1 job, 5★ (average = 5)
    addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_A'), 5);

    // Freelancer B: 20 jobs with average 4.8 (16 × 5★ + 4 × 4★ = 96 total, 96 / 20 = 4.8)
    for (let i = 0; i < 16; i++) {
      addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_B'), 5);
    }
    for (let i = 0; i < 4; i++) {
      addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_B'), 4);
    }

    // Global ratings: 30 total jobs, total rating = 27 + 5 + 96 = 128 -> m = 128 / 30 ≈ 4.2667
    // B score: (5 * (128/30) + 96) / (5 + 20) = 117.3333 / 25 = 4.69
    // A score: (5 * (128/30) + 5) / (5 + 1) = 26.3333 / 6 = 4.39
    const byScore = await request(app).get('/api/v1/reputation?sort=score').expect(200);
    const scoreAddresses = byScore.body.data.map((r: Reputation) => r.address);
    expect(scoreAddresses.indexOf(account('GFREELANCER_B'))).toBeLessThan(scoreAddresses.indexOf(account('GFREELANCER_A')));
    expect(byScore.body.data[0].address).toBe(account('GFREELANCER_B'));
    expect(byScore.body.data[0].score).toBe(4.69);
    expect(byScore.body.data[0].rank).toBe(1);
    expect(byScore.body.data[1].address).toBe(account('GFREELANCER_A'));
    expect(byScore.body.data[1].score).toBe(4.39);
    expect(byScore.body.data[1].rank).toBe(2);

    const byAvg = await request(app).get('/api/v1/reputation?sort=average').expect(200);
    const avgAddresses = byAvg.body.data.map((r: Reputation) => r.address);
    expect(avgAddresses.indexOf(account('GFREELANCER_A'))).toBeLessThan(avgAddresses.indexOf(account('GFREELANCER_B')));
    expect(byAvg.body.data[0].address).toBe(account('GFREELANCER_A'));
    expect(byAvg.body.data[0].averageRating).toBe(5);
    expect(byAvg.body.data[1].address).toBe(account('GFREELANCER_B'));
    expect(byAvg.body.data[1].averageRating).toBe(4.8);

    const byCompleted = await request(app).get('/api/v1/reputation?sort=completed').expect(200);
    expect(byCompleted.body.data.map((r: Reputation) => r.address)).toEqual([
      account('GFREELANCER_B'),
      account('GFREELANCER_C'),
      account('GFREELANCER_A'),
    ]);
  });

  it('tracks rating histogram, lastRatedAt, and preserves existing reputation fields', async () => {
    const store = new EscrowStore();
    const app = createApp(store);

    addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_H'), 5);
    addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_H'), 4);
    addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_H'), 5);
    addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_H'), 2);
    const last = addCompletedRatedJob(store, account('GCLIENT'), account('GFREELANCER_H'), 1);

    const res = await request(app).get(`/api/v1/reputation/${account('GFREELANCER_H')}`).expect(200);
    // GET /reputation/:address also carries asClient
    expect(res.body).toMatchObject({
      address: account('GFREELANCER_H'),
      completedContracts: 5,
      totalRating: 17,
      averageRating: 3.4,
      score: 3.4,
      rank: 1,
      histogram: [1, 1, 0, 1, 2],
      lastRatedAt: last.lastRatedAt,
    });
    expect(typeof res.body.lastRatedAt).toBe('string');
    expect(new Date(res.body.lastRatedAt).toISOString()).toBe(res.body.lastRatedAt);
  });

  it('returns rank: null and m = 3 score when no ratings exist globally, and rank for rated addresses', async () => {
    const emptyStore = new EscrowStore();
    const emptyApp = createApp(emptyStore);

    // With no ratings globally, m = 3 -> score = (C * 3 + 0) / (C + 0) = 3
    const emptyUnrated = await request(emptyApp).get(`/api/v1/reputation/${account('GUNRATED')}`).expect(200);
    expect(emptyUnrated.body).toMatchObject({
      address: account('GUNRATED'),
      completedContracts: 0,
      totalRating: 0,
      averageRating: 0,
      score: 3,
      rank: null,
      histogram: [0, 0, 0, 0, 0],
      lastRatedAt: null,
    });

    const store = new EscrowStore().seed();
    const app = createApp(store);

    const unrated = await request(app)
      .get(`/api/v1/reputation/${account('UNRATED_SEED')}`)
      .expect(200);
    expect(unrated.body).toMatchObject({
      address: account('UNRATED_SEED'),
      completedContracts: 0,
      totalRating: 0,
      averageRating: 0,
      score: 5,
      rank: null,
      histogram: [0, 0, 0, 0, 0],
      lastRatedAt: null,
    });

    const rated = await request(app)
      .get('/api/v1/reputation/GBQFACOFJHTDDQNQLQWUWWUK3EQPPTSEDREY6LKQHVAXLWFAMODA7ARV')
      .expect(200);
    expect(rated.body.rank).toBe(1);
    expect(rated.body.score).toBe(5);
    expect(rated.body.histogram).toEqual([0, 0, 0, 0, 1]);
  });

  it('filters by minCompleted, orders ties deterministically, and paginates without duplicates', async () => {
    const store = new EscrowStore({ priorWeight: 5 });
    const app = createApp(store);

    // Create ties on score/average:
    // F_Z and F_A both have 2 jobs with 5★ -> tied on score and completed, broken by address asc (F_A before F_Z)
    addCompletedRatedJob(store, account('GC'), account('GF_Z'), 5);
    addCompletedRatedJob(store, account('GC'), account('GF_Z'), 5);

    addCompletedRatedJob(store, account('GC'), account('GF_A'), 5);
    addCompletedRatedJob(store, account('GC'), account('GF_A'), 5);

    // F_MORE has 3 jobs with 5★ -> same average (5.0), whenglobal mean is 5.0 also same score (5.0),
    // tie broken by completed desc (F_MORE before F_A and F_Z)
    addCompletedRatedJob(store, account('GC'), account('GF_MORE'), 5);
    addCompletedRatedJob(store, account('GC'), account('GF_MORE'), 5);
    addCompletedRatedJob(store, account('GC'), account('GF_MORE'), 5);

    // F_ONE has 1 job with 5★
    addCompletedRatedJob(store, account('GC'), account('GF_ONE'), 5);

    // F_MID has 2 jobs with 4★
    addCompletedRatedJob(store, account('GC'), account('GF_MID'), 4);
    addCompletedRatedJob(store, account('GC'), account('GF_MID'), 4);

    // Deterministic tie-breaking on average (GF_MORE, GF_A, GF_Z, GF_ONE all have average 5):
    // Order must be: GF_MORE (3 jobs), GF_A (2 jobs, account('GF_A') < account('GF_Z')), GF_Z (2 jobs), GF_ONE (1 job), GF_MID (avg 4)
    const tied = [account('GF_A'), account('GF_Z')].sort();
    const expectedOrder = [account('GF_MORE'), ...tied, account('GF_ONE'), account('GF_MID')];
    const allByAvg = await request(app).get('/api/v1/reputation?sort=average').expect(200);
    expect(allByAvg.body.data.map((r: Reputation) => r.address)).toEqual(expectedOrder);

    // minCompleted filter
    const min2 = await request(app).get('/api/v1/reputation?sort=score&minCompleted=2').expect(200);
    expect(min2.body.data.map((r: Reputation) => r.address)).toEqual([account('GF_MORE'), ...tied, account('GF_MID')]);

    const min3 = await request(app).get('/api/v1/reputation?sort=score&minCompleted=3').expect(200);
    expect(min3.body.data.map((r: Reputation) => r.address)).toEqual([account('GF_MORE')]);

    // Cursor pagination without duplicates
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/reputation?sort=score&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const pageRes = await request(app).get(url).expect(200);
      expect(pageRes.body.page.limit).toBe(2);
      expect(pageRes.body.data.length).toBeLessThanOrEqual(2);
      for (const item of pageRes.body.data as Reputation[]) {
        seen.push(item.address);
      }
      cursor = pageRes.body.page.nextCursor;
      pages += 1;
      if (!pageRes.body.page.hasMore) {
        expect(cursor).toBeNull();
      }
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual(expectedOrder);
    expect(new Set(seen).size).toBe(5);
  });

  it('invalidates cached leaderboard immediately when a new rating is recorded', async () => {
    const store = new EscrowStore({ priorWeight: 5 });
    const app = createApp(store);

    addCompletedRatedJob(store, account('GC'), account('GF_1'), 3);
    addCompletedRatedJob(store, account('GC'), account('GF_2'), 4);

    // Warm the cache
    const first = await request(app).get('/api/v1/reputation?sort=score').expect(200);
    expect(first.body.data.map((r: Reputation) => r.address)).toEqual([account('GF_2'), account('GF_1')]);
    expect((await request(app).get(`/api/v1/reputation/${account('GF_1')}`)).body.rank).toBe(2);

    // Verify cached object is reused when no ratings occur, then invalidated on rate()
    const cacheBefore = (store as unknown as { leaderboardCache: unknown }).leaderboardCache;
    expect(cacheBefore).not.toBeNull();
    await request(app).get('/api/v1/reputation?sort=score').expect(200);
    expect((store as unknown as { leaderboardCache: unknown }).leaderboardCache).toBe(cacheBefore);

    // Rate GF_1 with two 5★ contracts via HTTP endpoint so GF_1 overtakes GF_2
    for (let i = 0; i < 2; i++) {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: account('GC'), freelancer: account('GF_1'), milestones: [{ amount: 50 }] })
        .expect(201);
      await request(app).post(`/api/v1/contracts/${created.body.id}/deposit`).send({ amount: 50 }).expect(200);
      await request(app).post(`/api/v1/contracts/${created.body.id}/milestones/0/release`).expect(200);
      await request(app).post(`/api/v1/contracts/${created.body.id}/reputation`).send({ rating: 5 }).expect(200);
    }

    const second = await request(app).get('/api/v1/reputation?sort=score').expect(200);
    expect(second.body.data.map((r: Reputation) => r.address)).toEqual([account('GF_1'), account('GF_2')]);
    expect(second.body.data[0].rank).toBe(1);
    expect(second.body.data[1].rank).toBe(2);
    expect((await request(app).get(`/api/v1/reputation/${account('GF_2')}`)).body.rank).toBe(2);
  });

  it('rejects invalid leaderboard query parameters', async () => {
    const store = new EscrowStore().seed();
    const app = createApp(store);

    await request(app).get('/api/v1/reputation?sort=invalid').expect(400);
    await request(app).get('/api/v1/reputation?limit=0').expect(400);
    await request(app).get('/api/v1/reputation?limit=101').expect(400);
    await request(app).get('/api/v1/reputation?limit=abc').expect(400);
    await request(app).get('/api/v1/reputation?minCompleted=-1').expect(400);
    await request(app).get('/api/v1/reputation?cursor=not-valid-base64-json').expect(400);
  });
});
