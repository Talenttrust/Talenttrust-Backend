/**
 * Tests for issue #1558 — integer base-unit amounts.
 *
 * Covers:
 *  - parseAmount rejects booleans, floats, exponent strings, whitespace, arrays, zero, negatives
 *  - parseAmount accepts safe integers and decimal strings
 *  - i128 overflow detection on milestone sum and deposit
 *  - resolveDispute integer split (truncation matches contract)
 *  - Route-level: deposit {amount: true} → 400, milestones [0.1] → 400, "1e2" → 400
 *  - JSON.stringify never throws on any route response (no raw bigint leaks)
 *  - Existing numeric fields still present in response
 *  - stats() uses bigint arithmetic
 */

import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore, HttpError } from '../src/store';
import { parseAmount, checkedAdd, I128_MAX, bigIntReplacer } from '../src/amount';

// ── parseAmount unit tests ────────────────────────────────────────────────────

describe('parseAmount', () => {
  describe('accepts valid inputs', () => {
    test.each<[unknown, bigint]>([
      [1, 1n],
      [1000, 1000n],
      [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
      ['1', 1n],
      ['100', 100n],
      // I128_MAX is 39 digits — regex allows up to 39 chars (^[1-9][0-9]{0,38}$)
      ['170141183460469231731687303715884105727', I128_MAX],
    ])('parseAmount(%p) → %s', (raw, expected) => {
      expect(parseAmount(raw, 'amount')).toBe(expected);
    });
  });

  describe('rejects invalid inputs with 400 invalid_amount', () => {
    const invalidCases: Array<[unknown, string]> = [
      [true, 'boolean true'],
      [false, 'boolean false'],
      [0, 'zero number'],
      [-1, 'negative number'],
      [0.1, 'float 0.1'],
      [1.5, 'float 1.5'],
      ['1e2', 'exponent string'],
      ['1E2', 'exponent string upper'],
      [' 7 ', 'whitespace'],
      ['0', 'zero string'],
      ['-1', 'negative string'],
      ['0.1', 'float string'],
      [[5], 'array'],
      [{ amount: 1 }, 'object'],
      [null, 'null'],
      [undefined, 'undefined'],
      ['', 'empty string'],
      ['01', 'leading zero string'],
      [NaN, 'NaN'],
      [Infinity, 'Infinity'],
    ];

    test.each(invalidCases)('rejects %s (%p)', (raw) => {
      expect(() => parseAmount(raw, 'amount')).toThrow(HttpError);
      try {
        parseAmount(raw, 'amount');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(400);
        expect((e as HttpError).code).toBe('invalid_amount');
      }
    });
  });
});

// ── i128 overflow ─────────────────────────────────────────────────────────────

describe('i128 overflow', () => {
  test('I128_MAX is 2^127 - 1', () => {
    expect(I128_MAX).toBe(170141183460469231731687303715884105727n);
  });

  test('checkedAdd within bounds succeeds', () => {
    expect(checkedAdd(1n, 1n, 'x')).toBe(2n);
    expect(checkedAdd(I128_MAX - 1n, 1n, 'x')).toBe(I128_MAX);
  });

  test('checkedAdd at I128_MAX + 1 throws 400 invalid_amount', () => {
    expect(() => checkedAdd(I128_MAX, 1n, 'x')).toThrow(HttpError);
    try {
      checkedAdd(I128_MAX, 1n, 'x');
    } catch (e) {
      expect((e as HttpError).status).toBe(400);
      expect((e as HttpError).code).toBe('invalid_amount');
    }
  });

  test('contract with milestone at I128_MAX is accepted', () => {
    const store = new EscrowStore();
    const c = store.create({
      client: 'GCLIENT000000000000000000000000000000000000000000000000000',
      freelancer: 'GFREELANCER00000000000000000000000000000000000000000000000',
      milestones: [{ title: 'M1', amount: '170141183460469231731687303715884105727' }],
    });
    expect(c.totalAmountUnits).toBe('170141183460469231731687303715884105727');
  });

  test('second milestone that overflows i128 is rejected with 400', () => {
    const store = new EscrowStore();
    expect(() =>
      store.create({
        client: 'GCLIENT000000000000000000000000000000000000000000000000000',
        freelancer: 'GFREELANCER00000000000000000000000000000000000000000000000',
        milestones: [
          { title: 'M1', amount: '170141183460469231731687303715884105727' },
          { title: 'M2', amount: 1 },
        ],
      }),
    ).toThrow(HttpError);
  });
});

// ── resolveDispute integer split ──────────────────────────────────────────────

describe('resolveDispute integer split', () => {
  /**
   * Each case: [held, bps, expectedToFreelancer]
   * to_freelancer = held * bps / 10000  (integer division — same truncation as contract)
   * to_client = held - to_freelancer  → to_freelancer + to_client === held always
   */
  const cases: Array<[bigint, number, bigint]> = [
    [10000n, 5000, 5000n],       // 50-50 split, no remainder
    [10001n, 5000, 5000n],       // odd remainder: truncates toward freelancer side
    [7n, 3333, 2n],              // 7 * 3333 / 10000 = 23331 / 10000 = 2 (truncated)
    [1n, 9999, 0n],              // 1 * 9999 / 10000 = 0 (truncated)
    [10000n, 0, 0n],             // 0% to freelancer
    [10000n, 10000, 10000n],     // 100% to freelancer
    [100n, 1, 0n],               // 100 * 1 / 10000 = 0 (truncated)
    [99999999n, 3333, 33329999n], // large value with odd remainder
  ];

  test.each(cases)(
    'held=%s bps=%d → toFreelancer=%s (to_freelancer + to_client === held)',
    (held, bps, expectedToFreelancer) => {
      // Verify the formula directly
      const toFreelancer = (held * BigInt(bps)) / 10000n;
      const toClient = held - toFreelancer;

      expect(toFreelancer).toBe(expectedToFreelancer);
      expect(toFreelancer + toClient).toBe(held); // invariant always holds
    },
  );

  test('store.resolveDispute uses integer split matching contract', () => {
    const store = new EscrowStore();
    const c = store.create({
      client: 'GCLIENT000000000000000000000000000000000000000000000000000',
      freelancer: 'GFREELANCER00000000000000000000000000000000000000000000000',
      milestones: [{ title: 'M', amount: 10001 }],
    });
    store.deposit(c.id, 10001);
    store.openDispute(c.id, 'GCLIENT000000000000000000000000000000000000000000000000000', 'test');
    const resolved = store.resolveDispute(c.id, 5000);
    // 10001 * 5000 / 10000 = 5000 (truncated, not rounded)
    expect(resolved.releasedAmountUnits).toBe('5000');
    expect(resolved.status).toBe('Resolved');
  });
});

// ── bigIntReplacer ────────────────────────────────────────────────────────────

describe('bigIntReplacer', () => {
  test('serialises bigint as decimal string', () => {
    const val = { amount: 12345n, nested: { x: 99n } };
    const json = JSON.stringify(val, bigIntReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.amount).toBe('12345');
    expect(parsed.nested.x).toBe('99');
  });

  test('does not affect non-bigint values', () => {
    const val = { n: 42, s: 'hello', b: true, nil: null };
    const json = JSON.stringify(val, bigIntReplacer);
    expect(JSON.parse(json)).toEqual(val);
  });

  test('raw bigint throws without replacer', () => {
    expect(() => JSON.stringify({ x: 1n })).toThrow();
  });
});

// ── route-level validation tests ──────────────────────────────────────────────

const makeApp = () => {
  const store = new EscrowStore();
  return { app: createApp({ store }), store };
};

function createContract(app: ReturnType<typeof createApp>, overrides: object = {}) {
  return request(app)
    .post('/api/v1/contracts')
    .send({
      client: 'GCLIENT000000000000000000000000000000000000000000000000000',
      freelancer: 'GFREELANCER00000000000000000000000000000000000000000000000',
      milestones: [{ title: 'M', amount: 1000 }],
      ...overrides,
    });
}

describe('POST /api/v1/contracts — milestone amount validation', () => {
  test('amount: 0.1 (float) → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const res = await createContract(app, { milestones: [{ amount: 0.1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('milestones [0.1, 0.2] → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const res = await createContract(app, {
      milestones: [{ amount: 0.1 }, { amount: 0.2 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('amount: true (boolean) → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const res = await createContract(app, { milestones: [{ amount: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('amount: "1e2" (exponent string) → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const res = await createContract(app, { milestones: [{ amount: '1e2' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('amount: [5] (array) → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const res = await createContract(app, { milestones: [{ amount: [5] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('valid integer amount → 201', async () => {
    const { app } = makeApp();
    const res = await createContract(app, { milestones: [{ amount: 1000000 }] });
    expect(res.status).toBe(201);
    expect(res.body.totalAmountUnits).toBe('1000000');
  });

  test('valid decimal string amount → 201', async () => {
    const { app } = makeApp();
    const res = await createContract(app, { milestones: [{ amount: '9999999' }] });
    expect(res.status).toBe(201);
    expect(res.body.totalAmountUnits).toBe('9999999');
  });
});

describe('POST /api/v1/contracts/:id/deposit — amount validation', () => {
  test('amount: true → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const c = await createContract(app);
    const res = await request(app)
      .post(`/api/v1/contracts/${c.body.id}/deposit`)
      .send({ amount: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('amount: "1e2" → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const c = await createContract(app);
    const res = await request(app)
      .post(`/api/v1/contracts/${c.body.id}/deposit`)
      .send({ amount: '1e2' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('amount: 0.5 (float) → 400 invalid_amount', async () => {
    const { app } = makeApp();
    const c = await createContract(app);
    const res = await request(app)
      .post(`/api/v1/contracts/${c.body.id}/deposit`)
      .send({ amount: 0.5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  test('valid integer deposit → 200, fundedAmountUnits updated', async () => {
    const { app } = makeApp();
    const c = await createContract(app, { milestones: [{ amount: 1000 }] });
    const res = await request(app)
      .post(`/api/v1/contracts/${c.body.id}/deposit`)
      .send({ amount: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.fundedAmountUnits).toBe('1000');
    expect(res.body.status).toBe('Funded');
  });
});

// ── legacy numeric fields still present ──────────────────────────────────────

describe('backwards-compat: numeric fields still present in response', () => {
  test('contract response includes both totalAmount (number) and totalAmountUnits (string)', async () => {
    const { app } = makeApp();
    const res = await createContract(app, { milestones: [{ amount: 5000 }] });
    expect(res.status).toBe(201);
    expect(typeof res.body.totalAmount).toBe('number');
    expect(typeof res.body.totalAmountUnits).toBe('string');
    expect(res.body.totalAmount).toBe(5000);
    expect(res.body.totalAmountUnits).toBe('5000');
    expect(typeof res.body.milestones[0].amount).toBe('number');
    expect(typeof res.body.milestones[0].amountUnits).toBe('string');
  });
});

// ── JSON.stringify never throws on any route ──────────────────────────────────

describe('no raw bigint leaks — JSON.stringify safe on every route', () => {
  let app: ReturnType<typeof createApp>;
  let contractId: number;

  beforeAll(async () => {
    const store = new EscrowStore();
    app = createApp({ store });
    // Create and fund a contract
    const createRes = await request(app)
      .post('/api/v1/contracts')
      .send({
        client: 'GCLIENT000000000000000000000000000000000000000000000000000',
        freelancer: 'GFREELANCER00000000000000000000000000000000000000000000000',
        milestones: [{ title: 'M', amount: 9999 }],
      });
    contractId = createRes.body.id;
    await request(app)
      .post(`/api/v1/contracts/${contractId}/deposit`)
      .send({ amount: 9999 });
  });

  const routes = [
    () => request(app).get('/'),
    () => request(app).get('/health'),
    () => request(app).get('/openapi.json'),
    () => request(app).get('/api/v1/chain'),
    () => request(app).get('/api/v1/stats'),
    () => request(app).get('/api/v1/contracts'),
    () => request(app).get(`/api/v1/contracts/${1}`),
  ];

  test.each(routes.map((r, i) => [i, r] as [number, () => request.Test]))(
    'route %i response is JSON.stringify-safe',
    async (_i, makeReq) => {
      const res = await makeReq();
      expect(res.status).toBeLessThan(500);
      // The response body was already serialised by the server — just verify
      // it's valid JSON (supertest already parsed it if Content-Type is json).
      expect(() => JSON.stringify(res.body)).not.toThrow();
    },
  );
});

// ── stats uses bigint arithmetic ──────────────────────────────────────────────

describe('stats() bigint arithmetic', () => {
  test('totalEscrowedUnits and totalReleasedUnits are decimal strings', async () => {
    const store = new EscrowStore();
    const app = createApp({ store });
    await request(app)
      .post('/api/v1/contracts')
      .send({
        client: 'GCLIENT000000000000000000000000000000000000000000000000000',
        freelancer: 'GFREELANCER00000000000000000000000000000000000000000000000',
        milestones: [{ amount: 1000000 }],
      })
      .then((r) =>
        request(app)
          .post(`/api/v1/contracts/${r.body.id}/deposit`)
          .send({ amount: 500000 }),
      );
    const res = await request(app).get('/api/v1/stats');
    expect(res.status).toBe(200);
    expect(typeof res.body.totalEscrowedUnits).toBe('string');
    expect(typeof res.body.totalReleasedUnits).toBe('string');
    expect(BigInt(res.body.totalEscrowedUnits)).toBeGreaterThan(0n);
  });
});

// ── openapi.json is valid ─────────────────────────────────────────────────────

describe('GET /openapi.json', () => {
  test('returns valid OpenAPI 3.0.3 document', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.info).toBeDefined();
    expect(res.body.paths).toBeDefined();
    expect(() => JSON.stringify(res.body)).not.toThrow();
  });

  test('EscrowContract schema includes *Units fields', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/openapi.json');
    const schema = res.body.components.schemas.EscrowContract.properties;
    expect(schema.totalAmountUnits).toBeDefined();
    expect(schema.fundedAmountUnits).toBeDefined();
    expect(schema.releasedAmountUnits).toBeDefined();
  });
});
