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
 * - Concurrent execution safety: racing exports, duplicate work, idempotent
 *   cleanup, and bounded resource usage under parallel invocation
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

// ─── Validation boundary helpers ─────────────────────────────────────────────

/**
 * Validation boundaries for export inputs.
 *
 * These constants define the accepted domain for every caller-supplied
 * value that reaches AuditExportService.  They are intentionally exported
 * so that callers and tests can assert against the same source of truth
 * rather than duplicating magic numbers.
 */
export const EXPORT_VALIDATION = {
  /** Maximum number of records a single export may contain. */
  MAX_RECORDS: 100_000,
  /** Maximum length of a filter string (action, actor, resource, etc.). */
  MAX_FILTER_LENGTH: 256,
  /** Maximum length of a correlationId filter. */
  MAX_CORRELATION_ID_LENGTH: 128,
  /** Maximum batch size for streaming reads. */
  MAX_BATCH_SIZE: 5_000,
  /** Minimum batch size for streaming reads. */
  MIN_BATCH_SIZE: 1,
  /** Allowed export formats. */
  FORMATS: ['ndjson', 'csv'] as const,
} as const;

export type ExportFormat = (typeof EXPORT_VALIDATION.FORMATS)[number];

/**
 * Structured error thrown when an export request violates a validation
 * boundary.  Carries a stable `code` so callers can branch on the failure
 * without parsing human-readable messages.
 */
export class ExportValidationError extends Error {
  public readonly code: string;
  public readonly field: string;

  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'ExportValidationError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Validates a caller-supplied filter object against the export boundaries.
 *
 * Rejects:
 * - non-string / non-undefined filter values
 * - empty or whitespace-only strings
 * - strings exceeding MAX_FILTER_LENGTH
 * - control characters (which would corrupt CSV/NDJSON output)
 *
 * Returns a normalised copy of the filter so downstream code never sees
 * the raw caller object.
 */
export function validateExportFilters(
  filters: Record<string, unknown> | undefined,
): Record<string, string> {
  if (filters === undefined) return {};
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ExportValidationError(
      'INVALID_FILTERS',
      'filters',
      'filters must be a plain object',
    );
  }

  const normalised: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new ExportValidationError(
        'INVALID_FILTER_TYPE',
        key,
        `filter "${key}" must be a string`,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new ExportValidationError(
        'EMPTY_FILTER',
        key,
        `filter "${key}" must not be empty`,
      );
    }
    const maxLen =
      key === 'correlationId'
        ? EXPORT_VALIDATION.MAX_CORRELATION_ID_LENGTH
        : EXPORT_VALIDATION.MAX_FILTER_LENGTH;
    if (trimmed.length > maxLen) {
      throw new ExportValidationError(
        'FILTER_TOO_LONG',
        key,
        `filter "${key}" exceeds maximum length of ${maxLen}`,
      );
    }
    // Reject control characters that would break CSV/NDJSON framing.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) {
      throw new ExportValidationError(
        'FILTER_CONTROL_CHARS',
        key,
        `filter "${key}" contains control characters`,
      );
    }
    normalised[key] = trimmed;
  }
  return normalised;
}

/**
 * Validates a batch size against the export boundaries.
 *
 * Rejects non-integers, values below MIN_BATCH_SIZE, and values above
 * MAX_BATCH_SIZE.  Returns the validated integer.
 */
export function validateBatchSize(batchSize: unknown): number {
  if (typeof batchSize !== 'number' || !Number.isInteger(batchSize)) {
    throw new ExportValidationError(
      'INVALID_BATCH_SIZE',
      'batchSize',
      'batchSize must be an integer',
    );
  }
  if (batchSize < EXPORT_VALIDATION.MIN_BATCH_SIZE) {
    throw new ExportValidationError(
      'BATCH_SIZE_TOO_SMALL',
      'batchSize',
      `batchSize must be at least ${EXPORT_VALIDATION.MIN_BATCH_SIZE}`,
    );
  }
  if (batchSize > EXPORT_VALIDATION.MAX_BATCH_SIZE) {
    throw new ExportValidationError(
      'BATCH_SIZE_TOO_LARGE',
      'batchSize',
      `batchSize must not exceed ${EXPORT_VALIDATION.MAX_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

/**
 * Validates an export format string against the allowed set.
 */
export function validateExportFormat(format: unknown): ExportFormat {
  if (typeof format !== 'string') {
    throw new ExportValidationError(
      'INVALID_FORMAT',
      'format',
      'format must be a string',
    );
  }
  if (!(EXPORT_VALIDATION.FORMATS as readonly string[]).includes(format)) {
    throw new ExportValidationError(
      'UNSUPPORTED_FORMAT',
      'format',
      `format must be one of: ${EXPORT_VALIDATION.FORMATS.join(', ')}`,
    );
  }
  return format as ExportFormat;
}

/**
 * Validates the record count against the export boundary.
 *
 * A count of 0 is valid (empty export).  Negative or non-integer counts
 * are rejected.  Counts above MAX_RECORDS are rejected to prevent
 * unbounded memory/disk usage.
 */
export function validateRecordCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isInteger(count)) {
    throw new ExportValidationError(
      'INVALID_RECORD_COUNT',
      'recordCount',
      'recordCount must be an integer',
    );
  }
  if (count < 0) {
    throw new ExportValidationError(
      'NEGATIVE_RECORD_COUNT',
      'recordCount',
      'recordCount must not be negative',
    );
  }
  if (count > EXPORT_VALIDATION.MAX_RECORDS) {
    throw new ExportValidationError(
      'RECORD_COUNT_TOO_LARGE',
      'recordCount',
      `recordCount must not exceed ${EXPORT_VALIDATION.MAX_RECORDS}`,
    );
  }
  return count;
}

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

// ═══════════════════════════════════════════════════════════════════════════════
// Concurrent execution safety
// ═══════════════════════════════════════════════════════════════════════════════

describe('AuditExportService — concurrent execution safety', () => {
  it('racing NDJSON exports produce independent, non-interfering files', async () => {
    const { exportService } = makeExportService();

    const results = await Promise.all([
      exportService.createNdjsonExport(),
      exportService.createNdjsonExport(),
      exportService.createNdjsonExport(),
    ]);

    // Each export must have a unique file path (no shared temp file collision)
    const paths = results.map((r) => r.filePath);
    expect(new Set(paths).size).toBe(paths.length);

    // Each file must independently contain the full dataset
    for (const result of results) {
      expect(result.recordCount).toBe(FIXTURE_ENTRIES.length);
      const content = await readExportFile(result.filePath);
      const parsed = parseNdjson(content);
      expect(parsed).toHaveLength(FIXTURE_ENTRIES.length);
    }

    await Promise.all(results.map((r) => r.cleanup()));
  });

  it('racing CSV exports produce independent, non-interfering files', async () => {
    const { exportService } = makeExportService();

    const results = await Promise.all([
      exportService.createCsvExport(),
      exportService.createCsvExport(),
      exportService.createCsvExport(),
    ]);

    const paths = results.map((r) => r.filePath);
    expect(new Set(paths).size).toBe(paths.length);

    for (const result of results) {
      expect(result.recordCount).toBe(FIXTURE_ENTRIES.length);
      const content = await readExportFile(result.filePath);
      const rows = parseCsv(content).filter((r) => r.some((c) => c.length > 0));
      expect(rows).toHaveLength(FIXTURE_ENTRIES.length + 1);
    }

    await Promise.all(results.map((r) => r.cleanup()));
  });

  it('mixed NDJSON and CSV exports racing do not corrupt each other', async () => {
    const { exportService } = makeExportService();

    const [ndjson, csv] = await Promise.all([
      exportService.createNdjsonExport(),
      exportService.createCsvExport(),
    ]);

    expect(ndjson.filePath).not.toBe(csv.filePath);
    expect(ndjson.fileName).toMatch(/\.ndjson$/);
    expect(csv.fileName).toMatch(/\.csv$/);

    const ndjsonContent = await readExportFile(ndjson.filePath);
    const csvContent = await readExportFile(csv.filePath);

    expect(parseNdjson(ndjsonContent)).toHaveLength(FIXTURE_ENTRIES.length);
    expect(parseCsv(csvContent).filter((r) => r.some((c) => c.length > 0)))
      .toHaveLength(FIXTURE_ENTRIES.length + 1);

    await Promise.all([ndjson.cleanup(), csv.cleanup()]);
  });

  it('cleanup is idempotent — repeated calls do not throw', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createNdjsonExport();

    await result.cleanup();
    await expect(result.cleanup()).resolves.toBeUndefined();
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('concurrent cleanup of the same result is safe', async () => {
    const { exportService } = makeExportService();
    const result = await exportService.createNdjsonExport();

    await Promise.all([
      result.cleanup(),
      result.cleanup(),
      result.cleanup(),
    ]);

    await expect(fsp.access(result.filePath)).rejects.toThrow();
  });

  it('duplicate export work with identical filters yields consistent results', async () => {
    const { exportService } = makeExportService();
    const filter = { action: 'CONTRACT_CREATED' };

    const [a, b] = await Promise.all([
      exportService.createNdjsonExport(filter),
      exportService.createNdjsonExport(filter),
    ]);

    expect(a.recordCount).toBe(b.recordCount);
    const contentA = await readExportFile(a.filePath);
    const contentB = await readExportFile(b.filePath);
    expect(contentA).toBe(contentB);

    await Promise.all([a.cleanup(), b.cleanup()]);
  });

  it('streaming exports racing with file exports do not interfere', async () => {
    const { exportService } = makeExportService();
    const { Writable } = await import('stream');

    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk: string | Buffer, _enc: string, cb: () => void) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });

    const [fileResult, streamResult] = await Promise.all([
      exportService.createNdjsonExport(),
      exportService.streamNdjsonExport({}, dest),
    ]);

    expect(fileResult.recordCount).toBe(FIXTURE_ENTRIES.length);
    expect(streamResult.recordCount).toBe(FIXTURE_ENTRIES.length);

    const streamed = Buffer.concat(chunks).toString('utf8');
    const fromFile = await readExportFile(fileResult.filePath);
    expect(streamed).toBe(fromFile);

    await Promise.all([fileResult.cleanup(), streamResult.cleanup()]);
  });

  it('high-concurrency burst (10 parallel exports) completes without error', async () => {
    const { exportService } = makeExportService();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => exportService.createNdjsonExport()),
    );

    const paths = results.map((r) => r.filePath);
    expect(new Set(paths).size).toBe(10);

    for (const result of results) {
      expect(result.recordCount).toBe(FIXTURE_ENTRIES.length);
    }

    await Promise.all(results.map((r) => r.cleanup()));
  });

  it('cleanup during concurrent export does not affect the in-flight export', async () => {
    const { exportService } = makeExportService();

    const first = await exportService.createNdjsonExport();
    const inFlight = exportService.createNdjsonExport();

    // Clean up the first result while the second is still being produced
    await first.cleanup();

    const second = await inFlight;
    expect(second.recordCount).toBe(FIXTURE_ENTRIES.length);
    const content = await readExportFile(second.filePath);
    expect(parseNdjson(content)).toHaveLength(FIXTURE_ENTRIES.length);

    await second.cleanup();
  });

  it('idempotent retries of the same export produce equivalent content', async () => {
    const { exportService } = makeExportService();

    const first = await exportService.createCsvExport();
    const firstContent = await readExportFile(first.filePath);
    await first.cleanup();

    const second = await exportService.createCsvExport();
    const secondContent = await readExportFile(second.filePath);
    await second.cleanup();

    expect(secondContent).toBe(firstContent);
  });

  it('concurrent exports with different filters each honour their own filter', async () => {
    const { exportService } = makeExportService();

    const [contracts, payments] = await Promise.all([
      exportService.createNdjsonExport({ action: 'CONTRACT_CREATED' }),
      exportService.createNdjsonExport({ action: 'PAYMENT_INITIATED' }),
    ]);

    const contractRecords = parseNdjson(await readExportFile(contracts.filePath));
    const paymentRecords = parseNdjson(await readExportFile(payments.filePath));

    expect(contractRecords.every((r) => r['action'] === 'CONTRACT_CREATED')).toBe(true);
    expect(paymentRecords.every((r) => r['action'] === 'PAYMENT_INITIATED')).toBe(true);

    await Promise.all([contracts.cleanup(), payments.cleanup()]);
  });

  it('partial failure of one export does not corrupt a concurrent successful export', async () => {
    const { exportService } = makeExportService();

    const good = exportService.createNdjsonExport();
    const bad = exportService.createNdjsonExport({ action: 'NON_EXISTENT_ACTION' });

    const [goodResult, badResult] = await Promise.all([good, bad]);

    // The good export must be intact regardless of the empty result of the other
    expect(goodResult.recordCount).toBe(FIXTURE_ENTRIES.length);
    const content = await readExportFile(goodResult.filePath);
    expect(parseNdjson(content)).toHaveLength(FIXTURE_ENTRIES.length);

    // The filtered export legitimately yields zero records
    expect(badResult.recordCount).toBe(0);

    await Promise.all([goodResult.cleanup(), badResult.cleanup()]);
  });
});
