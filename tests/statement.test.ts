/**
 * Tests for GET /api/v1/parties/:address/statement.csv and statement.json
 *
 * Acceptance criteria covered:
 *  ✓ Rows for an address that is client on one contract and freelancer on another
 *  ✓ role=client filter, role=freelancer filter
 *  ✓ date range filter (from/to)
 *  ✓ invalid / too-large range → 400 invalid_range
 *  ✓ Injection: title "=HYPERLINK(...)" exported as '=HYPERLINK(...) and quoted
 *  ✓ Titles with commas, quotes and newlines round-trip correctly
 *  ✓ Content-Type: text/csv and Content-Disposition headers asserted
 *  ✓ bom=true adds UTF-8 BOM
 *  ✓ JSON variant matches CSV rows
 *  ✓ GET /openapi.json still returns a valid OpenAPI 3.0.3 document with new paths
 */

import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { csvCell } from '../src/csv';
import { account } from './helpers/addresses';

// ── Minimal RFC 4180 CSV parser (no extra dependencies) ──────────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  // Strip UTF-8 BOM if present
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let pos = 0;
  const len = input.length;

  while (pos < len) {
    const row: string[] = [];
    while (pos < len) {
      if (input[pos] === '"') {
        // Quoted field
        pos++; // skip opening quote
        let field = '';
        while (pos < len) {
          if (input[pos] === '"') {
            if (input[pos + 1] === '"') {
              field += '"';
              pos += 2;
            } else {
              pos++; // skip closing quote
              break;
            }
          } else {
            field += input[pos++];
          }
        }
        row.push(field);
      } else {
        // Unquoted field – read until comma, CR, or LF
        let field = '';
        while (pos < len && input[pos] !== ',' && input[pos] !== '\r' && input[pos] !== '\n') {
          field += input[pos++];
        }
        row.push(field);
      }
      // After field: comma → next field; line ending → end of row
      if (pos < len && input[pos] === ',') {
        pos++;
      } else {
        break;
      }
    }
    rows.push(row);
    // Consume CRLF or bare LF
    if (pos < len && input[pos] === '\r') pos++;
    if (pos < len && input[pos] === '\n') pos++;
  }
  // Drop a trailing empty row if the file ends with CRLF
  if (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

// ── Date range covering everything created "now" (within the 3-year maximum) ──
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_FROM = new Date(Date.now() - 2 * 365 * DAY_MS).toISOString().slice(0, 10);
const RECENT_TO = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);

// ── Addresses used across tests ───────────────────────────────────────────────
const CLIENT     = account('GCLIENTTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
const FREELANCER = account('GFREELANCERTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
const OTHER_CLIENT = account('GCLIENTOTHERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');

// ── Store factory ─────────────────────────────────────────────────────────────
function buildStore() {
  // The store hands out copies, so backdating goes through its clock instead of mutating results.
  let now: number | undefined;
  const store = new EscrowStore(() => new Date(now ?? Date.now()));

  // c1: CLIENT=client, FREELANCER=freelancer
  const c1 = store.create({
    title: 'Logo design',
    client: CLIENT,
    freelancer: FREELANCER,
    milestones: [{ title: 'Draft', amount: 100 }],
  });

  // c2: FREELANCER=freelancer, different client
  const c2 = store.create({
    title: 'Smart contract audit',
    client: OTHER_CLIENT,
    freelancer: FREELANCER,
    milestones: [{ title: 'Report', amount: 500 }],
  });

  // c3: CLIENT=client – backdated to 2019 for date-filter tests
  now = Date.parse('2019-06-15T00:00:00.000Z');
  const c3 = store.create({
    title: 'Old project',
    client: CLIENT,
    freelancer: account('GFIXEDFREELANCERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    milestones: [{ title: 'Work', amount: 200 }],
  });
  now = undefined;

  // c4: injection-risk title
  const c4 = store.create({
    title: '=HYPERLINK("http://evil.example","click")',
    client: CLIENT,
    freelancer: account('GINJECTIONFREELANCERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    milestones: [{ title: 'Task', amount: 50 }],
  });

  // c5: title with comma, double-quote and embedded newline
  const c5 = store.create({
    title: 'Work, "quoted" and\nnewline',
    client: CLIENT,
    freelancer: account('GSPECIALFREELANCERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    milestones: [{ title: 'Task', amount: 75 }],
  });

  return { store, c1, c2, c3, c4, c5 };
}

// =============================================================================
// CSV – headers and basic structure
// =============================================================================
describe('Statement CSV – headers and structure', () => {
  it('returns 200 with text/csv content-type', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('includes Content-Disposition: attachment with .csv filename', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: '2024-01-01', to: '2025-01-01' });

    const cd = res.headers['content-disposition'] as string;
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/\.csv/);
    expect(cd).toContain('2024-01-01');
    expect(cd).toContain('2025-01-01');
  });

  it('first row is the column header', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      'contract_id', 'title', 'role', 'counterparty', 'token', 'status',
      'total_amount', 'funded_amount', 'released_amount', 'outstanding_amount',
      'dispute_freelancer_bps', 'created_at', 'updated_at',
    ]);
  });
});

// =============================================================================
// CSV – role and party filtering
// =============================================================================
describe('Statement CSV – role and party filtering', () => {
  it('returns rows for an address acting as client', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO, role: 'client' });

    const rows = parseCsv(res.text).slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect(row[2]).toBe('client');
  });

  it('returns rows for an address acting as freelancer across two clients', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${FREELANCER}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO, role: 'freelancer' });

    const rows = parseCsv(res.text).slice(1);
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row[2]).toBe('freelancer');
  });

  it('role=client returns empty for an address that is only a freelancer', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${FREELANCER}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO, role: 'client' });

    const rows = parseCsv(res.text).slice(1);
    expect(rows.length).toBe(0);
  });

  it('role=all returns both client and freelancer rows', async () => {
    // Create a store where CLIENT appears as both client and freelancer
    const store = new EscrowStore();
    store.create({
      title: 'As client',
      client: CLIENT,
      freelancer: account('GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      milestones: [{ amount: 100 }],
    });
    store.create({
      title: 'As freelancer',
      client: account('GOTHERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
      freelancer: CLIENT,
      milestones: [{ amount: 200 }],
    });

    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO, role: 'all' });

    const rows = parseCsv(res.text).slice(1);
    expect(rows.length).toBe(2);
    const roles = rows.map((r) => r[2]);
    expect(roles).toContain('client');
    expect(roles).toContain('freelancer');
  });
});

// =============================================================================
// CSV – date range filtering
// =============================================================================
describe('Statement CSV – date range filtering', () => {
  it('excludes contracts whose createdAt is before the from date', async () => {
    const { store } = buildStore();
    // c3 was backdated to 2019; a from=2020 range should exclude it
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    const rows = parseCsv(res.text).slice(1);
    for (const row of rows) {
      expect(new Date(row[11]).getFullYear()).toBeGreaterThanOrEqual(2020);
    }
  });

  it('includes only contracts inside a narrow window', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: '2019-01-01', to: '2020-01-01' });

    const rows = parseCsv(res.text).slice(1);
    expect(rows.length).toBe(1);
    expect(new Date(rows[0][11]).getFullYear()).toBe(2019);
  });

  it('defaults to last 365 days when no from/to supplied', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`);

    expect(res.status).toBe(200);
    // c3 (2019) must not appear
    const rows = parseCsv(res.text).slice(1);
    for (const row of rows) {
      const age = Date.now() - new Date(row[11]).getTime();
      expect(age).toBeLessThan(366 * 24 * 60 * 60 * 1000);
    }
  });
});

// =============================================================================
// CSV – error cases
// =============================================================================
describe('Statement CSV – error cases', () => {
  it('returns 400 invalid_range when from >= to', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: '2025-01-01', to: '2024-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_range');
  });

  it('returns 400 invalid_range when range exceeds 3 years', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: '2000-01-01', to: '2030-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_range');
  });

  it('returns 400 invalid_range for unparseable date strings', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: 'not-a-date', to: '2025-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_range');
  });

  it('returns 400 invalid_role for an unrecognised role value', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO, role: 'owner' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_role');
  });
});

// =============================================================================
// CSV – injection protection
// =============================================================================
describe('Statement CSV – injection protection', () => {
  it('prefixes =formula title with single-quote in the raw CSV text', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    // Raw CSV must contain the prefixed cell: '=HYPERLINK(...)
    expect(res.text).toContain("'=HYPERLINK(");
  });

  it('parsed injection title round-trips with the leading quote preserved', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    const rows = parseCsv(res.text).slice(1);
    const injRow = rows.find((r) => r[1].includes('HYPERLINK'));
    expect(injRow).toBeDefined();
    // The single-quote prefix is inside the double-quoted field, so the parser
    // sees it as part of the value: '=HYPERLINK(...)
    expect(injRow![1].startsWith("'=")).toBe(true);
  });

  it('title with comma, double-quote and newline round-trips correctly', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    const rows = parseCsv(res.text).slice(1);
    const specialRow = rows.find((r) => r[1].includes('quoted'));
    expect(specialRow).toBeDefined();
    expect(specialRow![1]).toBe('Work, "quoted" and\nnewline');
  });

  it('csvCell prefixes + - @ with single-quote', () => {
    expect(csvCell('+SUM(1)')).toBe("'+SUM(1)");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
  });

  it('csvCell wraps comma-containing values in double-quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('csvCell escapes embedded double-quotes as ""', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});

// =============================================================================
// CSV – BOM
// =============================================================================
describe('Statement CSV – BOM', () => {
  it('does NOT include a BOM by default', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    expect(res.text.startsWith('\uFEFF')).toBe(false);
  });

  it('prepends UTF-8 BOM when ?bom=true', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`)
      .query({ from: RECENT_FROM, to: RECENT_TO, bom: 'true' });

    expect(res.status).toBe(200);
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    // CSV must still parse correctly after BOM is stripped
    const rows = parseCsv(res.text);
    expect(rows[0][0]).toBe('contract_id');
  });
});

// =============================================================================
// JSON variant
// =============================================================================
describe('Statement JSON endpoint', () => {
  it('returns 200 with application/json content-type', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.json`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('response envelope has address, from, to, role and data array', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.json`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    expect(res.body).toHaveProperty('address', CLIENT);
    expect(res.body).toHaveProperty('from');
    expect(res.body).toHaveProperty('to');
    expect(res.body).toHaveProperty('role', 'all');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('every JSON row has all 13 required fields', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.json`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    for (const row of res.body.data as Array<Record<string, unknown>>) {
      for (const field of [
        'contract_id', 'title', 'role', 'counterparty', 'token', 'status',
        'total_amount', 'funded_amount', 'released_amount', 'outstanding_amount',
        'dispute_freelancer_bps', 'created_at', 'updated_at',
      ]) {
        expect(row).toHaveProperty(field);
      }
    }
  });

  it('JSON rows and CSV rows agree on contract_id, role, token and status', async () => {
    const { store } = buildStore();
    const params = { from: RECENT_FROM, to: RECENT_TO, role: 'client' };

    const csvRes = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.csv`).query(params);
    const jsonRes = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.json`).query(params);

    const csvRows = parseCsv(csvRes.text).slice(1);
    const jsonRows = jsonRes.body.data as Array<Record<string, unknown>>;

    expect(csvRows.length).toBe(jsonRows.length);
    for (let i = 0; i < jsonRows.length; i++) {
      expect(csvRows[i][0]).toBe(String(jsonRows[i].contract_id));
      expect(csvRows[i][2]).toBe(jsonRows[i].role);
      expect(csvRows[i][4]).toBe(jsonRows[i].token);
      expect(csvRows[i][5]).toBe(jsonRows[i].status);
    }
  });

  it('dispute_freelancer_bps is null for non-disputed contracts', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.json`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    for (const row of res.body.data as Array<Record<string, unknown>>) {
      expect(row.dispute_freelancer_bps).toBeNull();
    }
  });

  it('dispute_freelancer_bps reflects resolved bps from resolveDispute', async () => {
    const store = new EscrowStore();
    const c = store.create({
      title: 'Disputed engagement',
      client: CLIENT,
      freelancer: FREELANCER,
      milestones: [{ amount: 400 }],
    });
    store.deposit(c.id, 400);
    store.openDispute(c.id, FREELANCER, 'not satisfied');
    store.resolveDispute(c.id, 7500);

    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.json`)
      .query({ from: RECENT_FROM, to: RECENT_TO });

    expect(res.body.data[0].dispute_freelancer_bps).toBe(7500);
    expect(res.body.data[0].status).toBe('Resolved');
    // released = floor(400 * 7500 / 10000) = 300; outstanding = 0
    expect(res.body.data[0].released_amount).toBe(300);
    expect(res.body.data[0].outstanding_amount).toBe(0);
  });

  it('returns 400 invalid_range for bad date parameters', async () => {
    const { store } = buildStore();
    const res = await request(createApp({ store }))
      .get(`/api/v1/parties/${CLIENT}/statement.json`)
      .query({ from: '2030-01-01', to: '2020-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_range');
  });
});

// =============================================================================
// OpenAPI spec
// =============================================================================
describe('OpenAPI spec', () => {
  it('GET /openapi.json returns a valid 3.0.3 document', async () => {
    const res = await request(createApp(new EscrowStore()))
      .get('/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
  });

  it('spec includes paths for both new statement endpoints', async () => {
    const res = await request(createApp(new EscrowStore()))
      .get('/openapi.json');

    expect(res.body.paths).toHaveProperty(['/api/v1/parties/{address}/statement.csv']);
    expect(res.body.paths).toHaveProperty(['/api/v1/parties/{address}/statement.json']);
  });

  it('spec includes StatementRow schema in components', async () => {
    const res = await request(createApp(new EscrowStore()))
      .get('/openapi.json');

    expect(res.body.components.schemas).toHaveProperty('StatementRow');
  });

  it('spec documents the Parties tag', async () => {
    const res = await request(createApp(new EscrowStore()))
      .get('/openapi.json');

    const tagNames = (res.body.tags as Array<{ name: string }>).map((t) => t.name);
    expect(tagNames).toContain('Parties');
  });
});
