import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore, Reputation } from '../src/store';

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
      addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_C', 3);
    }

    // Freelancer A: 1 job, 5★ (average = 5)
    addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_A', 5);

    // Freelancer B: 20 jobs with average 4.8 (16 × 5★ + 4 × 4★ = 96 total, 96 / 20 = 4.8)
    for (let i = 0; i < 16; i++) {
      addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_B', 5);
    }
    for (let i = 0; i < 4; i++) {
      addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_B', 4);
    }

    // Global ratings: 30 total jobs, total rating = 27 + 5 + 96 = 128 -> m = 128 / 30 ≈ 4.2667
    // B score: (5 * (128/30) + 96) / (5 + 20) = 117.3333 / 25 = 4.69
    // A score: (5 * (128/30) + 5) / (5 + 1) = 26.3333 / 6 = 4.39
    const byScore = await request(app).get('/api/v1/reputation?sort=score').expect(200);
    const scoreAddresses = byScore.body.data.map((r: Reputation) => r.address);
    expect(scoreAddresses.indexOf('GFREELANCER_B')).toBeLessThan(scoreAddresses.indexOf('GFREELANCER_A'));
    expect(byScore.body.data[0].address).toBe('GFREELANCER_B');
    expect(byScore.body.data[0].score).toBe(4.69);
    expect(byScore.body.data[0].rank).toBe(1);
    expect(byScore.body.data[1].address).toBe('GFREELANCER_A');
    expect(byScore.body.data[1].score).toBe(4.39);
    expect(byScore.body.data[1].rank).toBe(2);

    const byAvg = await request(app).get('/api/v1/reputation?sort=average').expect(200);
    const avgAddresses = byAvg.body.data.map((r: Reputation) => r.address);
    expect(avgAddresses.indexOf('GFREELANCER_A')).toBeLessThan(avgAddresses.indexOf('GFREELANCER_B'));
    expect(byAvg.body.data[0].address).toBe('GFREELANCER_A');
    expect(byAvg.body.data[0].averageRating).toBe(5);
    expect(byAvg.body.data[1].address).toBe('GFREELANCER_B');
    expect(byAvg.body.data[1].averageRating).toBe(4.8);

    const byCompleted = await request(app).get('/api/v1/reputation?sort=completed').expect(200);
    expect(byCompleted.body.data.map((r: Reputation) => r.address)).toEqual([
      'GFREELANCER_B',
      'GFREELANCER_C',
      'GFREELANCER_A',
    ]);
  });

  it('tracks rating histogram, lastRatedAt, and preserves existing reputation fields', async () => {
    const store = new EscrowStore();
    const app = createApp(store);

    addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_H', 5);
    addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_H', 4);
    addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_H', 5);
    addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_H', 2);
    const last = addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_H', 1);

    const res = await request(app).get('/api/v1/reputation/GFREELANCER_H').expect(200);
    // GET /reputation/:address also carries asClient
    expect(res.body).toMatchObject({
      address: 'GFREELANCER_H',
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
    const emptyUnrated = await request(emptyApp).get('/api/v1/reputation/GUNRATED').expect(200);
    expect(emptyUnrated.body).toMatchObject({
      address: 'GUNRATED',
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
      .get('/api/v1/reputation/GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      .expect(200);
    expect(unrated.body).toMatchObject({
      address: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      completedContracts: 0,
      totalRating: 0,
      averageRating: 0,
      score: 5,
      rank: null,
      histogram: [0, 0, 0, 0, 0],
      lastRatedAt: null,
    });

    const rated = await request(app)
      .get('/api/v1/reputation/GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
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
    addCompletedRatedJob(store, 'GC', 'GF_Z', 5);
    addCompletedRatedJob(store, 'GC', 'GF_Z', 5);

    addCompletedRatedJob(store, 'GC', 'GF_A', 5);
    addCompletedRatedJob(store, 'GC', 'GF_A', 5);

    // F_MORE has 3 jobs with 5★ -> same average (5.0), whenglobal mean is 5.0 also same score (5.0),
    // tie broken by completed desc (F_MORE before F_A and F_Z)
    addCompletedRatedJob(store, 'GC', 'GF_MORE', 5);
    addCompletedRatedJob(store, 'GC', 'GF_MORE', 5);
    addCompletedRatedJob(store, 'GC', 'GF_MORE', 5);

    // F_ONE has 1 job with 5★
    addCompletedRatedJob(store, 'GC', 'GF_ONE', 5);

    // F_MID has 2 jobs with 4★
    addCompletedRatedJob(store, 'GC', 'GF_MID', 4);
    addCompletedRatedJob(store, 'GC', 'GF_MID', 4);

    // Deterministic tie-breaking on average (GF_MORE, GF_A, GF_Z, GF_ONE all have average 5):
    // Order must be: GF_MORE (3 jobs), GF_A (2 jobs, 'GF_A' < 'GF_Z'), GF_Z (2 jobs), GF_ONE (1 job), GF_MID (avg 4)
    const allByAvg = await request(app).get('/api/v1/reputation?sort=average').expect(200);
    expect(allByAvg.body.data.map((r: Reputation) => r.address)).toEqual([
      'GF_MORE',
      'GF_A',
      'GF_Z',
      'GF_ONE',
      'GF_MID',
    ]);

    // minCompleted filter
    const min2 = await request(app).get('/api/v1/reputation?sort=score&minCompleted=2').expect(200);
    expect(min2.body.data.map((r: Reputation) => r.address)).toEqual(['GF_MORE', 'GF_A', 'GF_Z', 'GF_MID']);

    const min3 = await request(app).get('/api/v1/reputation?sort=score&minCompleted=3').expect(200);
    expect(min3.body.data.map((r: Reputation) => r.address)).toEqual(['GF_MORE']);

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
    expect(seen).toEqual(['GF_MORE', 'GF_A', 'GF_Z', 'GF_ONE', 'GF_MID']);
    expect(new Set(seen).size).toBe(5);
  });

  it('invalidates cached leaderboard immediately when a new rating is recorded', async () => {
    const store = new EscrowStore({ priorWeight: 5 });
    const app = createApp(store);

    addCompletedRatedJob(store, 'GC', 'GF_1', 3);
    addCompletedRatedJob(store, 'GC', 'GF_2', 4);

    // Warm the cache
    const first = await request(app).get('/api/v1/reputation?sort=score').expect(200);
    expect(first.body.data.map((r: Reputation) => r.address)).toEqual(['GF_2', 'GF_1']);
    expect((await request(app).get('/api/v1/reputation/GF_1')).body.rank).toBe(2);

    // Verify cached object is reused when no ratings occur, then invalidated on rate()
    const cacheBefore = (store as unknown as { leaderboardCache: unknown }).leaderboardCache;
    expect(cacheBefore).not.toBeNull();
    await request(app).get('/api/v1/reputation?sort=score').expect(200);
    expect((store as unknown as { leaderboardCache: unknown }).leaderboardCache).toBe(cacheBefore);

    // Rate GF_1 with two 5★ contracts via HTTP endpoint so GF_1 overtakes GF_2
    for (let i = 0; i < 2; i++) {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GC', freelancer: 'GF_1', milestones: [{ amount: 50 }] })
        .expect(201);
      await request(app).post(`/api/v1/contracts/${created.body.id}/deposit`).send({ amount: 50 }).expect(200);
      await request(app).post(`/api/v1/contracts/${created.body.id}/milestones/0/release`).expect(200);
      await request(app).post(`/api/v1/contracts/${created.body.id}/reputation`).send({ rating: 5 }).expect(200);
    }

    const second = await request(app).get('/api/v1/reputation?sort=score').expect(200);
    expect(second.body.data.map((r: Reputation) => r.address)).toEqual(['GF_1', 'GF_2']);
    expect(second.body.data[0].rank).toBe(1);
    expect(second.body.data[1].rank).toBe(2);
    expect((await request(app).get('/api/v1/reputation/GF_2')).body.rank).toBe(2);
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

  it('validates reviews pagination parameters and rejects repeated values', async () => {
    const store = new EscrowStore();
    addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_REVIEWS', 5);
    addCompletedRatedJob(store, 'GCLIENT', 'GFREELANCER_REVIEWS', 4);
    const app = createApp(store);

    for (const limit of ['abc', '0', '101', '1.5']) {
      const response = await request(app).get(`/api/v1/reputation/GFREELANCER_REVIEWS/reviews?limit=${limit}`).expect(400);
      expect(response.body.error).toBe('invalid_limit');
    }
    for (const cursor of ['abc', '0', '-1', '1.5']) {
      const response = await request(app).get(`/api/v1/reputation/GFREELANCER_REVIEWS/reviews?cursor=${cursor}`).expect(400);
      expect(response.body.error).toBe('invalid_cursor');
    }

    const repeatedLimit = await request(app).get('/api/v1/reputation/GFREELANCER_REVIEWS/reviews?limit=1&limit=2').expect(400);
    expect(repeatedLimit.body.error).toBe('invalid_limit');
    const repeatedCursor = await request(app).get('/api/v1/reputation/GFREELANCER_REVIEWS/reviews?cursor=1&cursor=2').expect(400);
    expect(repeatedCursor.body.error).toBe('invalid_cursor');

    const firstPage = await request(app).get('/api/v1/reputation/GFREELANCER_REVIEWS/reviews?limit=1').expect(200);
    expect(firstPage.body.reviews).toHaveLength(1);
    expect(firstPage.body.nextCursor).toBeTruthy();

    const secondPage = await request(app)
      .get(`/api/v1/reputation/GFREELANCER_REVIEWS/reviews?limit=1&cursor=${firstPage.body.nextCursor}`)
      .expect(200);
    expect(secondPage.body.reviews).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it('filters leaderboard by since and windowDays without affecting lifetime rankings', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new EscrowStore({ clock: () => now, priorWeight: 5 });
    const app = createApp(store);

    // Old reviews (2026-01-01): GF_OLD dominates lifetime with five 5★ jobs; GF_RECENT has one 2★ job
    for (let i = 0; i < 5; i++) {
      addCompletedRatedJob(store, 'GCLIENT', 'GF_OLD', 5);
    }
    addCompletedRatedJob(store, 'GCLIENT', 'GF_RECENT', 2);

    // Advance clock 40 days to 2026-02-10
    now = new Date('2026-02-10T00:00:00.000Z');
    // Recent reviews: GF_RECENT gets three 5★ jobs; GF_OLD gets one 2★ job
    for (let i = 0; i < 3; i++) {
      addCompletedRatedJob(store, 'GCLIENT', 'GF_RECENT', 5);
    }
    const oldRecent = addCompletedRatedJob(store, 'GCLIENT', 'GF_OLD', 2);

    // Lifetime ranking: GF_OLD has 6 jobs (27 total, avg 4.5), GF_RECENT has 4 jobs (17 total, avg 4.25)
    // Global lifetime: 10 jobs, 44 total -> m = 4.4
    // GF_OLD score = round2((5*4.4 + 27) / 11) = round2(49 / 11) = 4.45
    // GF_RECENT score = round2((5*4.4 + 17) / 9) = round2(39 / 9) = 4.33
    const lifetime = await request(app).get('/api/v1/reputation?sort=score').expect(200);
    expect(lifetime.body.data.map((r: Reputation) => r.address)).toEqual(['GF_OLD', 'GF_RECENT']);
    expect(lifetime.body.data[0]).toMatchObject({
      address: 'GF_OLD',
      completedContracts: 6,
      totalRating: 27,
      averageRating: 4.5,
      score: 4.45,
      rank: 1,
      histogram: [0, 1, 0, 0, 5],
    });
    expect(lifetime.body.data[1]).toMatchObject({
      address: 'GF_RECENT',
      completedContracts: 4,
      totalRating: 17,
      averageRating: 4.25,
      score: 4.33,
      rank: 2,
      histogram: [0, 1, 0, 0, 3],
    });

    // Windowed ranking (?since=2026-02-01T00:00:00.000Z):
    // Only 2026-02-10 reviews count: GF_RECENT (3 jobs, 15 total, avg 5), GF_OLD (1 job, 2 total, avg 2)
    // Window global mean: 17 / 4 = 4.25
    // GF_RECENT score = round2((5*4.25 + 15) / 8) = round2(36.25 / 8) = 4.53
    // GF_OLD score = round2((5*4.25 + 2) / 6) = round2(23.25 / 6) = 3.88
    const bySince = await request(app).get('/api/v1/reputation?sort=score&since=2026-02-01T00:00:00.000Z').expect(200);
    expect(bySince.body.data.map((r: Reputation) => r.address)).toEqual(['GF_RECENT', 'GF_OLD']);
    expect(bySince.body.data[0]).toMatchObject({
      address: 'GF_RECENT',
      completedContracts: 3,
      totalRating: 15,
      averageRating: 5,
      score: 4.53,
      rank: 1,
      histogram: [0, 0, 0, 0, 3],
    });
    expect(bySince.body.data[1]).toMatchObject({
      address: 'GF_OLD',
      completedContracts: 1,
      totalRating: 2,
      averageRating: 2,
      score: 3.88,
      rank: 2,
      histogram: [0, 1, 0, 0, 0],
      lastRatedAt: oldRecent.lastRatedAt,
    });

    // windowDays=30 from 2026-02-10 gives the same window (since 2026-01-11)
    const byWindowDays = await request(app).get('/api/v1/reputation?sort=score&windowDays=30').expect(200);
    expect(byWindowDays.body.data).toEqual(bySince.body.data);
  });

  it('binds pagination cursors to the time window and rejects cross-window cursors', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new EscrowStore({ clock: () => now, priorWeight: 5 });
    const app = createApp(store);

    addCompletedRatedJob(store, 'GC', 'GF_A', 5);
    now = new Date('2026-02-01T00:00:00.000Z');
    addCompletedRatedJob(store, 'GC', 'GF_B', 5);
    addCompletedRatedJob(store, 'GC', 'GF_C', 4);
    addCompletedRatedJob(store, 'GC', 'GF_D', 3);

    // Paginate within since=2026-01-15
    const page1 = await request(app)
      .get('/api/v1/reputation?sort=score&limit=2&since=2026-01-15T00:00:00.000Z')
      .expect(200);
    expect(page1.body.data.map((r: Reputation) => r.address)).toEqual(['GF_B', 'GF_C']);
    expect(page1.body.page.hasMore).toBe(true);
    const windowCursor = page1.body.page.nextCursor as string;
    expect(windowCursor).toBeTruthy();

    // Same window succeeds
    const page2 = await request(app)
      .get(`/api/v1/reputation?sort=score&limit=2&since=2026-01-15T00:00:00.000Z&cursor=${encodeURIComponent(windowCursor)}`)
      .expect(200);
    expect(page2.body.data.map((r: Reputation) => r.address)).toEqual(['GF_D']);
    expect(page2.body.page.hasMore).toBe(false);

    // Different since rejected
    const wrongSince = await request(app)
      .get(`/api/v1/reputation?sort=score&limit=2&since=2026-01-20T00:00:00.000Z&cursor=${encodeURIComponent(windowCursor)}`)
      .expect(400);
    expect(wrongSince.body.error).toBe('invalid_cursor');

    // Lifetime query with windowed cursor rejected
    const wrongLifetime = await request(app)
      .get(`/api/v1/reputation?sort=score&limit=2&cursor=${encodeURIComponent(windowCursor)}`)
      .expect(400);
    expect(wrongLifetime.body.error).toBe('invalid_cursor');

    // windowDays query with since cursor rejected
    const wrongWindowDays = await request(app)
      .get(`/api/v1/reputation?sort=score&limit=2&windowDays=30&cursor=${encodeURIComponent(windowCursor)}`)
      .expect(400);
    expect(wrongWindowDays.body.error).toBe('invalid_cursor');
  });

  it('caches windowed leaderboards per window key and invalidates on new ratings', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');
    const store = new EscrowStore({ clock: () => now, priorWeight: 5 });
    const app = createApp(store);

    addCompletedRatedJob(store, 'GC', 'GF_1', 3);
    addCompletedRatedJob(store, 'GC', 'GF_2', 4);

    const first = await request(app).get('/api/v1/reputation?windowDays=30').expect(200);
    expect(first.body.data.map((r: Reputation) => r.address)).toEqual(['GF_2', 'GF_1']);

    const cacheMap = (store as unknown as { windowedLeaderboardCache: Map<string, unknown> }).windowedLeaderboardCache;
    const cachedEntry = cacheMap.get('windowDays:30');
    expect(cachedEntry).toBeDefined();

    // Second request reuses cached entry
    await request(app).get('/api/v1/reputation?windowDays=30').expect(200);
    expect(cacheMap.get('windowDays:30')).toBe(cachedEntry);

    // New rating invalidates windowed cache
    addCompletedRatedJob(store, 'GC', 'GF_1', 5);
    addCompletedRatedJob(store, 'GC', 'GF_1', 5);
    expect(cacheMap.size).toBe(0);

    const second = await request(app).get('/api/v1/reputation?windowDays=30').expect(200);
    expect(second.body.data.map((r: Reputation) => r.address)).toEqual(['GF_1', 'GF_2']);
  });

  it('rejects malformed, future, or mutually exclusive since/windowDays with 400 invalid_since', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');
    const store = new EscrowStore({ clock: () => now });
    const app = createApp(store);

    const badQueries = [
      'since=not-a-date',
      'since=2026-02-30',
      'since=2026-02-11T00:00:00.000Z',
      'windowDays=0',
      'windowDays=-7',
      'windowDays=abc',
      'windowDays=1.5',
      'since=2026-02-01T00:00:00.000Z&windowDays=30',
    ];

    for (const q of badQueries) {
      const res = await request(app).get(`/api/v1/reputation?${q}`).expect(400);
      expect(res.body.error).toBe('invalid_since');
    }
  });
});
