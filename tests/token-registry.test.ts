import request from 'supertest';

import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import {
  buildTokenRegistry,
  formatUnits,
  getTokenRegistry,
  resolveToken,
  USDC_TESTNET_CONTRACT_ID,
  XLM_CONTRACT_ID,
} from '../src/tokens';

const CONTRACT_STRKEY = /^[CD][A-Z2-7]{55}$/;
const ACCOUNT_STRKEY = /^G[A-Z2-7]{55}$/;
/** Well-formed but unregistered contract ids for negative cases. */
const OTHER_CONTRACT_ID = 'C' + 'E'.repeat(55);
const CUSTOM_CONTRACT_ID = 'C' + 'B'.repeat(55);
const CUSTOM_ISSUER = 'G' + 'A'.repeat(55);

describe('default token registry', () => {
  it('registers the native XLM SAC with 7 decimals and no issuer', () => {
    expect(XLM_CONTRACT_ID).toMatch(CONTRACT_STRKEY);
    const xlm = resolveToken('XLM');
    expect(xlm).toMatchObject({
      symbol: 'XLM',
      name: 'Stellar Lumens',
      contractId: XLM_CONTRACT_ID,
      decimals: 7,
      issuer: null,
    });
  });

  it('registers the testnet USDC SAC (contract id and issuer configurable)', () => {
    expect(USDC_TESTNET_CONTRACT_ID).toMatch(CONTRACT_STRKEY);
    const usdc = resolveToken('USDC');
    expect(usdc).toMatchObject({
      symbol: 'USDC',
      contractId: USDC_TESTNET_CONTRACT_ID,
      decimals: 7,
    });

    const custom = buildTokenRegistry({
      TOKENS_USDC_CONTRACT_ID: CUSTOM_CONTRACT_ID,
      TOKENS_USDC_ISSUER: CUSTOM_ISSUER,
    });
    const customUsdc = custom.find((t) => t.symbol === 'USDC');
    expect(customUsdc).toMatchObject({ contractId: CUSTOM_CONTRACT_ID, issuer: CUSTOM_ISSUER });
  });

  it('resolves symbols case-insensitively and contract ids exactly', () => {
    expect(resolveToken('xLm')?.symbol).toBe('XLM');
    expect(resolveToken('usdc')?.symbol).toBe('USDC');
    expect(resolveToken(XLM_CONTRACT_ID)?.symbol).toBe('XLM');
    expect(resolveToken(USDC_TESTNET_CONTRACT_ID)?.symbol).toBe('USDC');
    expect(resolveToken('DOGE')).toBeUndefined();
    expect(resolveToken(OTHER_CONTRACT_ID)).toBeUndefined();
    expect(resolveToken('')).toBeUndefined();
    expect(resolveToken('   ')).toBeUndefined();
    expect(resolveToken(42)).toBeUndefined();
    expect(resolveToken(null)).toBeUndefined();
  });

  it('rejects a malformed TOKENS_USDC_CONTRACT_ID at startup', () => {
    expect(() => buildTokenRegistry({ TOKENS_USDC_CONTRACT_ID: 'not-a-contract' })).toThrow(
      /default token USDC\.contractId/,
    );
  });

  it('exposes the process registry through getTokenRegistry', () => {
    expect(getTokenRegistry().length).toBeGreaterThanOrEqual(2);
    expect(getTokenRegistry().map((t) => t.symbol)).toEqual(expect.arrayContaining(['XLM', 'USDC']));
  });
});

// ── Formatting: string math only, never floats ────────────────────────────────

describe('formatUnits', () => {
  it('formats 7-decimal (stroops-precision) amounts with a padded fraction', () => {
    expect(formatUnits(1500000000n, 7)).toBe('150.0000000');
    expect(formatUnits('1500000000', 7)).toBe('150.0000000');
    expect(formatUnits(1n, 7)).toBe('0.0000001');
    expect(formatUnits(0n, 7)).toBe('0.0000000');
  });

  it('formats amounts below one unit', () => {
    expect(formatUnits(12345n, 7)).toBe('0.0012345');
    expect(formatUnits(1n, 2)).toBe('0.01');
    expect(formatUnits(5n, 2)).toBe('0.05');
    expect(formatUnits(99n, 2)).toBe('0.99');
    expect(formatUnits(0n, 2)).toBe('0.00');
    expect(formatUnits(9n, 0)).toBe('9');
  });

  it('formats 2-decimal amounts', () => {
    expect(formatUnits(150n, 2)).toBe('1.50');
    expect(formatUnits(123456789n, 2)).toBe('1234567.89');
  });

  it('formats 0-decimal amounts as plain integers', () => {
    expect(formatUnits(150n, 0)).toBe('150');
    expect(formatUnits(0n, 0)).toBe('0');
    // Float math would corrupt this: Number('9007199254740993') === 9007199254740992.
    expect(formatUnits('9007199254740993', 0)).toBe('9007199254740993');
  });

  it('handles very large values exactly (i128 max, 7 decimals)', () => {
    const i128Max = 2n ** 127n - 1n;
    expect(i128Max.toString()).toBe('170141183460469231731687303715884105727');
    expect(formatUnits(i128Max, 7)).toBe('17014118346046923173168730371588.4105727');
    expect(formatUnits('115792089237316195423570985008687907853269984665640564039457584007913129639935', 0)).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    );
  });

  it('rejects non-integer input instead of guessing', () => {
    expect(() => formatUnits('1.5', 7)).toThrow(/integer base-unit amount/);
    expect(() => formatUnits('1e7', 7)).toThrow(/integer base-unit amount/);
    expect(() => formatUnits(100n, -1)).toThrow(/non-negative integer/);
  });
});

// ── TOKENS_JSON: override/extend + startup validation ─────────────────────────

describe('TOKENS_JSON', () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void): void => {
    const previous = process.env.TOKENS_JSON;
    if (env.TOKENS_JSON === undefined) delete process.env.TOKENS_JSON;
    else process.env.TOKENS_JSON = env.TOKENS_JSON;
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env.TOKENS_JSON;
      else process.env.TOKENS_JSON = previous;
    }
  };

  it('overrides a default entry by symbol and extends the registry with new symbols', () => {
    const registry = buildTokenRegistry({
      TOKENS_JSON: JSON.stringify([
        {
          symbol: 'USDC',
          name: 'USD Coin (custom)',
          contractId: USDC_TESTNET_CONTRACT_ID,
          decimals: 2,
          issuer: null,
        },
        { symbol: 'FOO', name: 'Foo Token', contractId: CUSTOM_CONTRACT_ID, decimals: 0, issuer: null },
      ]),
    });
    const usdc = registry.find((t) => t.symbol === 'USDC');
    expect(usdc).toMatchObject({ name: 'USD Coin (custom)', decimals: 2 });
    expect(registry.find((t) => t.symbol === 'FOO')).toMatchObject({
      contractId: CUSTOM_CONTRACT_ID,
      decimals: 0,
    });
    // Extend semantics: untouched defaults survive.
    expect(registry.find((t) => t.symbol === 'XLM')).toMatchObject({ decimals: 7 });
  });

  it('rejects invalid JSON with a clear message', () => {
    expect(() => buildTokenRegistry({ TOKENS_JSON: 'not json' })).toThrow(/TOKENS_JSON is not valid JSON/);
  });

  it('rejects a non-array payload', () => {
    expect(() => buildTokenRegistry({ TOKENS_JSON: '{"symbol":"XLM"}' })).toThrow(
      /TOKENS_JSON must be a JSON array/,
    );
  });

  it('rejects an entry missing required fields, naming the entry', () => {
    const entry = { symbol: 'FOO', name: 'Foo', contractId: CUSTOM_CONTRACT_ID };
    expect(() => buildTokenRegistry({ TOKENS_JSON: JSON.stringify([entry]) })).toThrow(
      /TOKENS_JSON\[0\]\.decimals/,
    );
  });

  it('rejects invalid decimals', () => {
    const base = { symbol: 'FOO', name: 'Foo', contractId: CUSTOM_CONTRACT_ID };
    expect(() => buildTokenRegistry({ TOKENS_JSON: JSON.stringify([{ ...base, decimals: 1.5 }]) })).toThrow(
      /TOKENS_JSON\[0\]\.decimals must be an integer/,
    );
    expect(() => buildTokenRegistry({ TOKENS_JSON: JSON.stringify([{ ...base, decimals: -1 }]) })).toThrow(
      /TOKENS_JSON\[0\]\.decimals/,
    );
    expect(() => buildTokenRegistry({ TOKENS_JSON: JSON.stringify([{ ...base, decimals: 19 }]) })).toThrow(
      /TOKENS_JSON\[0\]\.decimals/,
    );
  });

  it('rejects a malformed contract id or issuer', () => {
    expect(() =>
      buildTokenRegistry({
        TOKENS_JSON: JSON.stringify([
          { symbol: 'FOO', name: 'Foo', contractId: 'not-a-contract', decimals: 7 },
        ]),
      }),
    ).toThrow(/TOKENS_JSON\[0\]\.contractId/);
    expect(() =>
      buildTokenRegistry({
        TOKENS_JSON: JSON.stringify([
          { symbol: 'FOO', name: 'Foo', contractId: CUSTOM_CONTRACT_ID, decimals: 7, issuer: 'GBAD' },
        ]),
      }),
    ).toThrow(/TOKENS_JSON\[0\]\.issuer/);
  });

  it('rejects entries that are not objects and unknown fields', () => {
    expect(() => buildTokenRegistry({ TOKENS_JSON: '[1,2]' })).toThrow(/TOKENS_JSON\[0\] must be an object/);
    expect(() =>
      buildTokenRegistry({
        TOKENS_JSON: JSON.stringify([
          { symbol: 'FOO', name: 'Foo', contractId: CUSTOM_CONTRACT_ID, decimals: 7, typo: true },
        ]),
      }),
    ).toThrow(/TOKENS_JSON\[0\] has unknown field "typo"/);
  });

  it('fails module load (startup) when TOKENS_JSON is invalid', () => {
    const missingDecimals = JSON.stringify([
      { symbol: 'BROKEN', name: 'Broken Token', contractId: CUSTOM_CONTRACT_ID },
    ]);
    withEnv({ TOKENS_JSON: missingDecimals }, () => {
      jest.isolateModules(() => {
        expect(() => require('../src/tokens')).toThrow(/TOKENS_JSON\[0\]\.decimals/);
      });
    });
  });

  it('boots with a valid TOKENS_JSON override applied to the live registry', () => {
    withEnv(
      {
        TOKENS_JSON: JSON.stringify([
          {
            symbol: 'USDC',
            name: 'USD Coin custom',
            contractId: USDC_TESTNET_CONTRACT_ID,
            decimals: 2,
            issuer: null,
          },
        ]),
      },
      () => {
        jest.isolateModules(() => {
          const tokens = require('../src/tokens') as typeof import('../src/tokens');
          expect(tokens.resolveToken('usdc')?.decimals).toBe(2);
          expect(tokens.resolveToken('XLM')?.decimals).toBe(7);
          expect(tokens.formatUnits(150n, tokens.resolveToken('usdc')!.decimals)).toBe('1.50');
        });
      },
    );
  });
});

// ── HTTP: create validation, registry routes, display, stats, seed ────────────

describe('POST /api/v1/contracts token validation', () => {
  const app = createApp(new EscrowStore());
  const create = (body: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1500000000 }], ...body });

  it('accepts a registered symbol and stores the resolved contract id', async () => {
    const res = await create({ token: 'XLM' }).expect(201);
    expect(res.body.token).toBe('XLM');
    expect(res.body.tokenContractId).toBe(XLM_CONTRACT_ID);
    expect(res.body.display).toEqual({
      totalAmount: '150.0000000',
      fundedAmount: '0.0000000',
      releasedAmount: '0.0000000',
    });
    expect(res.body.totalAmountUnits).toBe('1500000000');
  });

  it('accepts a lowercase symbol and canonicalises it to the registered symbol', async () => {
    const res = await create({ token: 'xlm' }).expect(201);
    expect(res.body.token).toBe('XLM');
    expect(res.body.tokenContractId).toBe(XLM_CONTRACT_ID);
  });

  it('accepts the SAC contract id', async () => {
    const res = await create({ token: XLM_CONTRACT_ID }).expect(201);
    expect(res.body.token).toBe('XLM');
    expect(res.body.tokenContractId).toBe(XLM_CONTRACT_ID);
  });

  it('accepts a second registered token (USDC)', async () => {
    const res = await create({ token: 'usdc' }).expect(201);
    expect(res.body.token).toBe('USDC');
    expect(res.body.tokenContractId).toBe(USDC_TESTNET_CONTRACT_ID);
  });

  it('rejects an unknown symbol with 400 unsupported_token', async () => {
    const res = await create({ token: 'DOGE' }).expect(400);
    expect(res.body.error).toBe('unsupported_token');
    expect(res.body.message).toContain('DOGE');
  });

  it('rejects an unregistered contract id with 400 unsupported_token', async () => {
    const res = await create({ token: OTHER_CONTRACT_ID }).expect(400);
    expect(res.body.error).toBe('unsupported_token');
  });

  it('defaults to XLM when token is omitted', async () => {
    const res = await create().expect(201);
    expect(res.body.token).toBe('XLM');
    expect(res.body.tokenContractId).toBe(XLM_CONTRACT_ID);
  });
});

describe('GET /api/v1/tokens', () => {
  const app = createApp(new EscrowStore());

  it('lists the registry as { data: Token[] }', async () => {
    const res = await request(app).get('/api/v1/tokens').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const symbols = res.body.data.map((t: { symbol: string }) => t.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['XLM', 'USDC']));
    const xlm = res.body.data.find((t: { symbol: string }) => t.symbol === 'XLM');
    expect(xlm).toMatchObject({ contractId: XLM_CONTRACT_ID, decimals: 7, issuer: null });
  });

  it('returns one token by symbol, case-insensitively', async () => {
    const res = await request(app).get('/api/v1/tokens/usdc').expect(200);
    expect(res.body).toMatchObject({ symbol: 'USDC', contractId: USDC_TESTNET_CONTRACT_ID, decimals: 7 });
  });

  it('returns one token by contract id', async () => {
    const res = await request(app).get(`/api/v1/tokens/${XLM_CONTRACT_ID}`).expect(200);
    expect(res.body.symbol).toBe('XLM');
  });

  it('returns 404 token_not_found for unknown tokens', async () => {
    const res = await request(app).get('/api/v1/tokens/DOGE').expect(404);
    expect(res.body.error).toBe('token_not_found');
    expect(res.body.title).toBe('Token not found');
  });
});

describe('contract display formatting', () => {
  const app = createApp(new EscrowStore());

  it('formats totals with the token decimals while base units stay exact', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', token: 'XLM', milestones: [{ amount: 1500000000 }] })
      .expect(201);
    await request(app)
      .post(`/api/v1/contracts/${created.body.id}/deposit`)
      .send({ amount: 1500000000 })
      .expect(200);
    await request(app).post(`/api/v1/contracts/${created.body.id}/milestones/0/release`).expect(200);

    const res = await request(app).get(`/api/v1/contracts/${created.body.id}`).expect(200);
    expect(res.body.display).toEqual({
      totalAmount: '150.0000000',
      fundedAmount: '150.0000000',
      releasedAmount: '150.0000000',
    });
    expect(res.body.totalAmountUnits).toBe('1500000000');
    expect(res.body.fundedAmountUnits).toBe('1500000000');
    expect(res.body.tokenContractId).toBe(XLM_CONTRACT_ID);
  });

  it('uses TOKENS_JSON-configured decimals for display', () => {
    const previous = process.env.TOKENS_JSON;
    process.env.TOKENS_JSON = JSON.stringify([
      { symbol: 'XLM', name: 'Stellar Lumens', contractId: XLM_CONTRACT_ID, decimals: 2, issuer: null },
    ]);
    try {
      jest.isolateModules(() => {
        const { EscrowStore: FreshStore } = require('../src/store') as typeof import('../src/store');
        const contract = new FreshStore().create({
          client: 'GA',
          freelancer: 'GB',
          token: 'xlm',
          milestones: [{ amount: 150 }],
        });
        expect(contract.display.totalAmount).toBe('1.50');
      });
    } finally {
      if (previous === undefined) delete process.env.TOKENS_JSON;
      else process.env.TOKENS_JSON = previous;
    }
  });
});

describe('stats() byToken', () => {
  it('breaks totals down per token with two tokens', async () => {
    const store = new EscrowStore();
    const xlm = store.create({ client: 'GA', freelancer: 'GB', token: 'XLM', milestones: [{ amount: 1000000 }] });
    store.deposit(xlm.id, 1000000);
    store.release(xlm.id, 0);
    const usdc = store.create({ client: 'GA', freelancer: 'GB', token: 'USDC', milestones: [{ amount: 2000000 }] });
    store.deposit(usdc.id, 2000000);

    const stats = store.stats();
    expect(stats.byToken).toEqual({
      USDC: { totalEscrowed: '2000000', totalReleased: '0' },
      XLM: { totalEscrowed: '0', totalReleased: '1000000' },
    });
    // Legacy top-level totals are kept (they mix units across tokens).
    expect(stats.totalEscrowedUnits).toBe('2000000');
    expect(stats.totalReleasedUnits).toBe('1000000');
    expect(typeof stats.totalEscrowed).toBe('number');

    const app = createApp(store);
    const res = await request(app).get('/api/v1/stats').expect(200);
    expect(res.body.byToken).toEqual(stats.byToken);
  });
});

describe('seed data', () => {
  it('uses only registered tokens', () => {
    const store = new EscrowStore().seed();
    const seeded = store.list().map((c) => c.token);
    expect(new Set(seeded)).toEqual(new Set(['XLM', 'USDC']));
    for (const symbol of seeded) {
      expect(resolveToken(symbol)).toBeDefined();
      expect(store.list().every((c) => resolveToken(c.token)?.contractId === c.tokenContractId)).toBe(true);
    }
  });
});
