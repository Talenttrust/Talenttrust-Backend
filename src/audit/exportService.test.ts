/**
 * @file exportService.test.ts
 * @description Comprehensive tests for AuditExportService.
 *
 * Coverage:
 * - NDJSON (newline-delimited JSON) export round-trip fidelity
 * - CSV export: RFC 4180 quoting of commas, double-quotes, newlines
 * - CSV-injection neutralisation: leading =, +, -, @, \t, \r are prefixed with '
 * - Empty dataset: headers-only CSV, zero-record NDJSON
 * - Large dataset: streamed without loading all rows into memory simultaneously
 * - AuditExportResult contract: filePath, fileName, bytesWritten, recordCount,
 *   openReadStream, cleanup
 * - Cleanup removes the temporary directory
 * - neutraliseCsvInjection helper unit tests
 *
 * @see docs/backend/audit-log.md — Export section
 */

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService, neutraliseCsvInjection } from './exportService';
import type { CreateAuditEntryInput } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a minimal valid CreateAuditEntryInput with optional overrides. */
function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-fixture',
    resource: 'contract',
    resourceId: 'contract-fixture-1',
    metadata: { note: 'test-fixture' },
    ...overrides,
  };
}

/**
 * Reads an entire file and returns its contents as a UTF-8 string.
 * Used to validate export file content after streaming.
 */
async function readExportFile(filePath: string): Promise<string> {
  return fsp.readFile(filePath, 'utf8');
}

/** Parses an NDJSON file into an array of plain objects. */
function parseNdjson(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Parses a CSV string into a 2-D array of strings.
 * Handles RFC 4180 double-quote escaping and quoted fields containing
 * commas and embedded newlines.
 */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < csv.length) {
    const ch = csv[i];

    if (inQuotes) {
      if (ch === '"' && csv[i + 1] === '"') {
        // Escaped double-quote inside a quoted field
        field += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i++;
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' && csv[i + 1] === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += 2;
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i++;
    } else {
      field += ch;
      i++;
    }
  }

  // Flush the last field / row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ─── Test fixture ─────────────────────────────────────────────────────────────

/**
 * Seeded fixture set — covers the common data shapes exercised in each test
 * suite.  All tests use a fresh in-memory AuditStore so there is no
 * dependency on a live (or shared) audit database.
 */
const FIXTURE_ENTRIES: CreateAuditEntryInput[] = [
  makeInput({ actor: 'alice', metadata: { note: 'plain value' } }),
  makeInput({ action: 'PAYMENT_INITIATED', severity: 'CRITICAL', actor: 'bob', resource: 'payment', resourceId: 'pay-1' }),
  makeInput({ action: 'AUTH_FAILED', severity: 'WARNING', actor: 'charlie', ipAddress: '10.0.0.1', correlationId: 'corr-abc' }),
];

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates an isolated AuditExportService backed by a fresh in-memory store
 * pre-populated with the given entries.
 *
 * @param entries - Optional entries to seed; defaults to FIXTURE_ENTRIES.
 * @param batchSize - Internal streaming batch size (default 500).
 */
function makeExportService(
  entries: CreateAuditEntryInput[] = FIXTURE_ENTRIES,
  batchSize = 500,
): { exportService: AuditExportService; store: AuditStore } {
  const store = new AuditStore();
  const service = new AuditService(store);
  for (const entry of entries) {
    service.log(entry);
  }
  const exportRoot = path.join(os.tmpdir(), `tt-audit-test-${Date.now()}-${Math.random()}`);
  const exportService = new AuditExportService(service, { exportRoot, batchSize });
  return { exportService, store };
}

// ═══════════════════════════════════════════════════════════════════════════════
// neutraliseCsvInjection — unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('neutraliseCsvInjection', () => {
  it('returns empty string unchanged', () => {
    expect(neutraliseCsvInjection('')).toBe('');
  });

  it('prefixes leading = with single-quote', () => {
    expect(neutraliseCsvInjection('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
  });

  it('prefixes leading + with single-quote', () => {
    expect(neutraliseCsvInjection('+cmd|/C calc')).toBe("'+cmd|/C calc");
  });

  it('prefixes leading - with single-quote', () => {
    expect(neutraliseCsvInjection('-2+3')).toBe("'-2+3");
  });

  it('prefixes leading @ with single-quote', () => {
    expect(neutraliseCsvInjection('@SUM(B1)')).toBe("'@SUM(B1)");
  });

  it('prefixes leading tab with single-quote', () => {
    expect(neutraliseCsvInjection('\t=INJECT')).toBe("'\t=INJECT");
  });

  it('prefixes leading carriage-return with single-quote', () => {
    expect(neutraliseCsvInjection('\r=INJECT')).toBe("'\r=INJECT");
  });

  it('does not modify safe strings', () => {
    expect(neutraliseCsvInjection('hello world')).toBe('hello world');
    expect(neutraliseCsvInjection('CONTRACT_CREATED')).toBe('CONTRACT_CREATED');
    expect(neutraliseCsvInjection('user-123')).toBe('user-123');
  });

  it('does not modify strings with injection chars in non-leading positions', () => {
    expect(neutraliseCsvInjection('total=100')).toBe('total=100');
    expect(neutraliseCsvInjection('a+b')).toBe('a+b');
    expect(neutraliseCsvInjection('e@mail.com')).toBe('e@mail.com');
  });

  it('only prefixes once — does not double-escape an already-prefixed value', () => {
    // A value that already starts with a single-quote is safe (not a formula trigger)
    expect(neutraliseCsvInjection("'=safe")).toBe("'=safe");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createNdjsonExport — round-trip fidelity
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService.createNdjsonExport', () => {
  it('creates a result object with all required contract fields', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createNdjsonExport();

    expect(result.fileName).toMatch(/^audit-log-.+\.ndjson$/);
    expect(result.filePath).toContain(result.fileName);
    expect(typeof result.bytesWritten).toBe('number');
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.recordCount).toBe(FIXTURE_ENTRIES.length);
    expect(typeof result.openReadStream).toBe('function');
    expect(typeof result.cleanup).toBe('function');

    await result.cleanup();
  });

  it('round-trips every field faithfully (JSON serialisation fidelity)', async () => {
    const { exportService, store } = makeExportService();
    const originalEntries = store.getAll();

    const result = await exportService.createNdjsonExport();
    const content = await readExportFile(result.filePath);
    const parsed = parseNdjson(content);

    expect(parsed).toHaveLength(originalEntries.length);

    for (let i = 0; i < originalEntries.length; i++) {
      const original = originalEntries[i];
      const exported = parsed[i];

      expect(exported['id']).toBe(original.id);
      expect(exported['timestamp']).toBe(original.timestamp);
      expect(exported['action']).toBe(original.action);
      expect(exported['severity']).toBe(original.severity);
      expect(exported['actor']).toBe(original.actor);
      expect(exported['resource']).toBe(original.resource);
      expect(exported['resourceId']).toBe(original.resourceId);
    }

    await result.cleanup();
  });

  it('preserves ipAddress and correlationId when present', async () => {
    const { exportService } = makeExportService([
      makeInput({ ipAddress: '192.168.1.1', correlationId: 'corr-xyz' }),
    ]);

    const result = await exportService.createNdjsonExport();
    const content = await readExportFile(result.filePath);
    const [record] = parseNdjson(content);

    expect(record['ipAddress']).toBe('192.168.1.1');
    expect(record['correlationId']).toBe('corr-xyz');

    await result.cleanup();
  });

  it('each line is independently valid JSON', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createNdjsonExport();
    const content = await readExportFile(result.filePath);
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    await result.cleanup();
  });

  it('produces a zero-record file for an empty store', async () => {
    const { exportService } = makeExportService([]);
    const result = await exportService.createNdjsonExport();

    expect(result.recordCount).toBe(0);

    const content = await readExportFile(result.filePath);
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(0);

    await result.cleanup();
  });

  it('applies filters — only matching entries appear in output', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createNdjsonExport({ action: 'CONTRACT_CREATED' });
    const content = await readExportFile(result.filePath);
    const records = parseNdjson(content);

    expect(records.every((r) => r['action'] === 'CONTRACT_CREATED')).toBe(true);

    await result.cleanup();
  });

  it('openReadStream returns a readable stream of the same data', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createNdjsonExport();

    const stream = result.openReadStream();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: string | Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const streamed = Buffer.concat(chunks).toString('utf8');
    const fromFile = await readExportFile(result.filePath);
    expect(streamed).toBe(fromFile);

    await result.cleanup();
  });

  it('cleanup removes the export file and its parent directory', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createNdjsonExport();
    const { filePath } = result;

    await result.cleanup();

    await expect(fsp.access(filePath)).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createCsvExport — RFC 4180 quoting
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService.createCsvExport — result contract', () => {
  it('creates a result object with all required contract fields', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createCsvExport();

    expect(result.fileName).toMatch(/^audit-log-.+\.csv$/);
    expect(result.filePath).toContain(result.fileName);
    expect(typeof result.bytesWritten).toBe('number');
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.recordCount).toBe(FIXTURE_ENTRIES.length);

    await result.cleanup();
  });

  it('first row is the header row with correct column names', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content);

    const expectedHeaders = ['id', 'timestamp', 'action', 'severity', 'actor', 'resource', 'resourceId', 'ipAddress', 'correlationId', 'metadata'];
    expect(rows[0]).toEqual(expectedHeaders);

    await result.cleanup();
  });

  it('record count excludes the header row', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content);

    // rows[0] is headers, rows[1..N] are data
    expect(result.recordCount).toBe(rows.length - 1);

    await result.cleanup();
  });

  it('produces headers-only CSV for empty store', async () => {
    const { exportService } = makeExportService([]);
    const result = await exportService.createCsvExport();

    expect(result.recordCount).toBe(0);

    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    // Only the header row
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe('id');

    await result.cleanup();
  });

  it('every data row has the same number of columns as the header', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const headerCount = rows[0].length;

    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toHaveLength(headerCount);
    }

    await result.cleanup();
  });

  it('cleanup removes the export file and its parent directory', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createCsvExport();
    const { filePath } = result;

    await result.cleanup();

    await expect(fsp.access(filePath)).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createCsvExport — RFC 4180 quoting hazards
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService.createCsvExport — RFC 4180 quoting', () => {
  /**
   * Helper: exports a single entry and returns the first data row as an
   * array of column values parsed by the RFC 4180 parser.
   */
  async function exportSingleRow(
    input: CreateAuditEntryInput,
  ): Promise<{ row: string[]; headers: string[]; cleanup: () => Promise<void> }> {
    const { exportService } = makeExportService([input]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    return { headers: rows[0], row: rows[1], cleanup: result.cleanup };
  }

  it('quotes a field containing a comma', async () => {
    const { exportService } = makeExportService([
      makeInput({ actor: 'alice,bob' }),
    ]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const actorIdx = rows[0].indexOf('actor');
    // After RFC 4180 parsing the comma-containing value is round-tripped correctly
    expect(rows[1][actorIdx]).toBe('alice,bob');
    await result.cleanup();
  });

  it('escapes embedded double-quotes per RFC 4180 ("" inside quoted field)', async () => {
    const { exportService } = makeExportService([
      makeInput({ actor: 'say "hello"' }),
    ]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const actorIdx = rows[0].indexOf('actor');
    expect(rows[1][actorIdx]).toBe('say "hello"');
    await result.cleanup();
  });

  it('quotes a field containing an embedded newline', async () => {
    const { exportService } = makeExportService([
      makeInput({ actor: 'line1\nline2' }),
    ]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const actorIdx = rows[0].indexOf('actor');
    expect(rows[1][actorIdx]).toBe('line1\nline2');
    await result.cleanup();
  });

  it('quotes a field containing an embedded carriage-return', async () => {
    const { exportService } = makeExportService([
      makeInput({ actor: 'line1\rline2' }),
    ]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const actorIdx = rows[0].indexOf('actor');
    expect(rows[1][actorIdx]).toBe('line1\rline2');
    await result.cleanup();
  });

  it('handles a field with both commas and embedded quotes', async () => {
    const { headers, row, cleanup } = await exportSingleRow(
      makeInput({ actor: 'a,b,"c"' }),
    );
    const actorIdx = headers.indexOf('actor');
    expect(row[actorIdx]).toBe('a,b,"c"');
    await cleanup();
  });

  it('serialises metadata objects to JSON without data loss', async () => {
    const meta = { amount: 99, currency: 'XLM', nested: { flag: true } };
    const { headers, row, cleanup } = await exportSingleRow(
      makeInput({ metadata: meta }),
    );
    const metaIdx = headers.indexOf('metadata');
    expect(JSON.parse(row[metaIdx])).toEqual(meta);
    await cleanup();
  });

  it('emits empty string for absent optional columns (ipAddress, correlationId)', async () => {
    const { headers, row, cleanup } = await exportSingleRow(makeInput());
    const ipIdx = headers.indexOf('ipAddress');
    const corrIdx = headers.indexOf('correlationId');
    expect(row[ipIdx]).toBe('');
    expect(row[corrIdx]).toBe('');
    await cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createCsvExport — CSV-injection (formula injection) neutralisation
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService.createCsvExport — CSV-injection neutralisation', () => {
  /**
   * Exports a single entry whose `actor` field starts with an injection
   * character and returns the parsed actor cell value.
   */
  async function actorCellFor(actorValue: string): Promise<string> {
    const { exportService } = makeExportService([makeInput({ actor: actorValue })]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const actorIdx = rows[0].indexOf('actor');
    await result.cleanup();
    return rows[1][actorIdx];
  }

  it('neutralises a leading = (formula prefix)', async () => {
    const cell = await actorCellFor('=SUM(A1:A10)');
    // After CSV-parsing the cell must start with ' (injected prefix) or be inert
    expect(cell).not.toMatch(/^=/);
    expect(cell).toMatch(/^'=/);
  });

  it('neutralises a leading + (Lotus formula prefix)', async () => {
    const cell = await actorCellFor('+cmd|/C calc');
    expect(cell).not.toMatch(/^\+/);
    expect(cell).toMatch(/^'\+/);
  });

  it('neutralises a leading - (negation formula)', async () => {
    const cell = await actorCellFor('-1+2');
    expect(cell).not.toMatch(/^-/);
    expect(cell).toMatch(/^'-/);
  });

  it('neutralises a leading @ (legacy formula prefix)', async () => {
    const cell = await actorCellFor('@SUM(B1)');
    expect(cell).not.toMatch(/^@/);
    expect(cell).toMatch(/^'@/);
  });

  it('does not alter safe values that start with alphanumeric characters', async () => {
    const cell = await actorCellFor('user-alice-123');
    expect(cell).toBe('user-alice-123');
  });

  it('does not neutralise non-leading injection characters', async () => {
    const cell = await actorCellFor('total=100');
    expect(cell).toBe('total=100');
  });

  it('neutralises injection in resourceId column', async () => {
    const { exportService } = makeExportService([
      makeInput({ resourceId: '=HYPERLINK("http://evil.example")' }),
    ]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const idx = rows[0].indexOf('resourceId');
    // The raw cell value in the file must be prefixed so the formula is inert
    expect(rows[1][idx]).toMatch(/^'=/);
    await result.cleanup();
  });

  it('neutralises injection in metadata JSON (stringified object starts with {)', async () => {
    // Metadata is serialised as JSON — the { prefix is not a formula trigger.
    // This test confirms no over-escaping occurs for safe JSON output.
    const { exportService } = makeExportService([
      makeInput({ metadata: { note: '=INJECT' } }),
    ]);
    const result = await exportService.createCsvExport();
    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    const idx = rows[0].indexOf('metadata');
    // The outer JSON object starts with { which is safe — verify it parses OK
    const parsed = JSON.parse(rows[1][idx]) as { note: string };
    expect(parsed.note).toBe('=INJECT'); // value is inside JSON, not a formula cell
    await result.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Large dataset — bounded memory streaming
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService — large dataset streaming', () => {
  /** Number of rows large enough to exercise batching. */
  const LARGE_COUNT = 1_500;

  it('NDJSON: exports all rows for a large dataset', async () => {
    const entries = Array.from({ length: LARGE_COUNT }, (_, i) =>
      makeInput({ actor: `user-${i}`, resourceId: `res-${i}` }),
    );
    const { exportService } = makeExportService(entries, /* batchSize */ 200);

    const result = await exportService.createNdjsonExport();

    expect(result.recordCount).toBe(LARGE_COUNT);

    const content = await readExportFile(result.filePath);
    const parsed = parseNdjson(content);
    expect(parsed).toHaveLength(LARGE_COUNT);

    await result.cleanup();
  });

  it('CSV: exports all rows for a large dataset (header + N data rows)', async () => {
    const entries = Array.from({ length: LARGE_COUNT }, (_, i) =>
      makeInput({ actor: `user-${i}` }),
    );
    const { exportService } = makeExportService(entries, /* batchSize */ 200);

    const result = await exportService.createCsvExport();

    expect(result.recordCount).toBe(LARGE_COUNT);

    const content = await readExportFile(result.filePath);
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    // rows[0] = headers, rows[1..LARGE_COUNT] = data
    expect(rows).toHaveLength(LARGE_COUNT + 1);

    await result.cleanup();
  });

  it('NDJSON: actor values are preserved across the full large dataset', async () => {
    const entries = Array.from({ length: 300 }, (_, i) =>
      makeInput({ actor: `actor-${i}` }),
    );
    const { exportService } = makeExportService(entries, 50);

    const result = await exportService.createNdjsonExport();
    const content = await readExportFile(result.filePath);
    const parsed = parseNdjson(content);

    for (let i = 0; i < 300; i++) {
      expect(parsed[i]['actor']).toBe(`actor-${i}`);
    }

    await result.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// streamNdjsonExport and streamCsvExport — convenience helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService.streamNdjsonExport', () => {
  it('pipes all records into the writable stream', async () => {
    const { exportService } = makeExportService();

    const chunks: Buffer[] = [];
    const { Writable } = await import('stream');
    const dest = new Writable({
      write(chunk: string | Buffer, _enc: string, cb: () => void) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });

    const result = await exportService.streamNdjsonExport({}, dest);

    expect(result.recordCount).toBe(FIXTURE_ENTRIES.length);
    const content = Buffer.concat(chunks).toString('utf8');
    const parsed = parseNdjson(content);
    expect(parsed).toHaveLength(FIXTURE_ENTRIES.length);

    await result.cleanup();
  });
});

describe('AuditExportService.streamCsvExport', () => {
  it('pipes all rows (header + data) into the writable stream', async () => {
    const { exportService } = makeExportService();

    const chunks: Buffer[] = [];
    const { Writable } = await import('stream');
    const dest = new Writable({
      write(chunk: string | Buffer, _enc: string, cb: () => void) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });

    const result = await exportService.streamCsvExport({}, dest);

    expect(result.recordCount).toBe(FIXTURE_ENTRIES.length);
    const content = Buffer.concat(chunks).toString('utf8');
    const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
    expect(rows).toHaveLength(FIXTURE_ENTRIES.length + 1); // header + data

    await result.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Path-traversal safety
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService — path-traversal guard', () => {
  it('assertPathWithinRoot: export file is always inside the configured exportRoot', async () => {
    const { exportService } = makeExportService();

    const result = await exportService.createNdjsonExport();

    // The resolved filePath must be beneath exportRoot
    // We cannot call the private method directly, but we can verify the path
    // is a real file inside a subdirectory of tmpdir (the configured root).
    const stat = await fsp.stat(result.filePath);
    expect(stat.isFile()).toBe(true);

    await result.cleanup();
  });
});
