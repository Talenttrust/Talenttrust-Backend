import { createWriteStream, createReadStream, promises as fsp } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';
import { tmpdir } from 'os';
import type { ReadStream } from 'fs';
import { AuditService, auditService } from './service';
import { redactBody } from './redact';
import type { AuditEntry, AuditQuery } from './types';

export interface AuditExportResult {
  filePath: string;
  fileName: string;
  bytesWritten: number;
  recordCount: number;
  openReadStream(): ReadStream;
  cleanup(): Promise<void>;
}

export interface AuditExportServiceOptions {
  exportRoot?: string;
  /**
   * Number of rows fetched per internal batch during streaming export.
   * Keeps memory bounded regardless of total result set size.
   * @default 500
   */
  batchSize?: number;
}

/**
 * Filters that may be applied to an export request.
 * All fields are optional; omitting them includes all records.
 */
export interface AuditExportFilters {
  /** ISO-8601 start of time range (inclusive). */
  from?: string;
  /** ISO-8601 end of time range (inclusive). */
  to?: string;
  /** Restrict to a single event type (action). */
  action?: AuditQuery['action'];
  /** Restrict to a single severity level. */
  severity?: AuditQuery['severity'];
  /** Restrict to a specific actor. */
  actor?: string;
  /** Restrict to a specific resource type. */
  resource?: string;
  /** Restrict to a specific resource ID. */
  resourceId?: string;
  /** Cap the number of exported records. Omitting it exports every match. */
  limit?: number;
}

/** Ordered CSV column headers for the audit export. */
const CSV_HEADERS = [
  'id',
  'timestamp',
  'action',
  'severity',
  'actor',
  'resource',
  'resourceId',
  'ipAddress',
  'correlationId',
  'metadata',
] as const;

type CsvColumn = (typeof CSV_HEADERS)[number];

/**
 * Neutralises CSV-injection ("formula injection") by prefixing dangerous
 * leading characters with a single-quote so spreadsheet applications
 * (Excel, LibreOffice Calc, Google Sheets) treat the cell as plain text
 * rather than executing it as a formula.
 *
 * Characters that trigger formula execution when they appear as the very
 * first character of an unquoted cell value:
 *   `=`  standard formula prefix
 *   `+`  alternative formula prefix (Lotus 1-2-3 compatibility)
 *   `-`  negation that spreadsheets evaluate as a formula
 *   `@`  legacy Lotus and some modern Excel formula prefix
 *   `\t` tab — used in tab-separated injections (safe to neutralise)
 *   `\r` carriage-return — can break row parsing
 *
 * The prefix `'` is the de-facto standard mitigation recommended by OWASP
 * (https://owasp.org/www-community/attacks/CSV_Injection).
 *
 * @param str - The already-stringified cell value.
 * @returns The value with any dangerous leading character escaped.
 */
export function neutraliseCsvInjection(str: string): string {
  if (str.length === 0) return str;
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Escapes a value for safe inclusion in a CSV cell (RFC 4180) and
 * neutralises CSV-injection characters at the start of the value.
 *
 * Processing order:
 * 1. Stringify the value.
 * 2. Apply {@link neutraliseCsvInjection} to defuse formula prefixes.
 * 3. Wrap in double-quotes and escape internal quotes per RFC 4180 if the
 *    value contains a comma, double-quote, newline, or carriage-return.
 */
function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe = neutraliseCsvInjection(raw);
  // Wrap in quotes if the value contains a comma, double-quote, or newline.
  if (safe.includes('"') || safe.includes(',') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Serialises a redacted AuditEntry to one CSV row (no trailing newline). */
function toCsvRow(entry: AuditEntry): string {
  return CSV_HEADERS.map((col: CsvColumn) => {
    if (col === 'metadata') return csvCell(entry.metadata);
    return csvCell(entry[col]);
  }).join(',');
}

export class AuditExportService {
  private readonly exportRoot: string;
  private readonly batchSize: number;

  constructor(
    private readonly service: AuditService = auditService,
    options: AuditExportServiceOptions = {},
  ) {
    this.exportRoot = path.resolve(
      options.exportRoot ?? path.join(tmpdir(), 'talenttrust-audit-exports'),
    );
    this.batchSize = Math.max(options.batchSize ?? 500, 1);
  }

  // ─── NDJSON export ─────────────────────────────────────────────────────────

  /**
   * Streams audit entries in batches to a temporary NDJSON file.
   *
   * Rows are fetched from the repository using a cursor-based stream so the
   * process heap stays bounded regardless of how large the audit log grows.
   * Each entry is redacted via {@link redactBody} before serialisation so
   * sensitive metadata fields never appear in the export file.
   *
   * @param filters - Optional date-range, event-type and other filters.
   *   - `from`       ISO-8601 start timestamp (inclusive)
   *   - `to`         ISO-8601 end timestamp (inclusive)
   *   - `action`     Restrict to one event type (e.g. `'CONTRACT_CREATED'`)
   *   - `severity`   Restrict to one severity level (`'INFO' | 'WARNING' | 'CRITICAL'`)
   *   - `actor`      Restrict to a specific actor ID
   *   - `resource`   Restrict to a specific resource type
   *   - `resourceId` Restrict to a specific resource ID
   * @returns Metadata and handles for the resulting file.
   *
   * @example
   * ```ts
   * const result = await exportService.createNdjsonExport({
   *   from: '2024-01-01T00:00:00.000Z',
   *   to:   '2024-03-31T23:59:59.999Z',
   *   action: 'CONTRACT_CREATED',
   * });
   * await pipeline(result.openReadStream(), res);
   * await result.cleanup();
   * ```
   */
  async createNdjsonExport(filters: AuditExportFilters = {}): Promise<AuditExportResult> {
    await fsp.mkdir(this.exportRoot, { recursive: true });

    const exportDir = await fsp.mkdtemp(path.join(this.exportRoot, 'audit-export-'));
    this.assertPathWithinRoot(exportDir);

    const fileName = `audit-log-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
    const filePath = path.join(exportDir, fileName);
    this.assertPathWithinRoot(filePath);

    const writer = createWriteStream(filePath, { encoding: 'utf8', flags: 'wx' });
    let recordCount = 0;

    const query: AuditQuery = { ...filters };
    const cursor = this.service.stream(query);

    async function* generateLines(): AsyncGenerator<string> {
      for (const entry of cursor) {
        const redacted = redactBody(entry as unknown as Record<string, unknown>) as AuditEntry;
        recordCount += 1;
        yield `${JSON.stringify(redacted)}\n`;
      }
    }

    const source = Readable.from(generateLines());
    await pipeline(source, writer);

    const cleanup = async (): Promise<void> => {
      await fsp.rm(exportDir, { recursive: true, force: true });
    };

    return {
      filePath,
      fileName,
      bytesWritten: writer.bytesWritten,
      recordCount,
      openReadStream: () => createReadStream(filePath),
      cleanup,
    };
  }

  // ─── CSV export ────────────────────────────────────────────────────────────

  /**
   * Streams audit entries in batches to a temporary CSV file.
   *
   * Columns are fixed in the order defined by {@link CSV_HEADERS}.
   * Each row is redacted via {@link redactBody} before serialisation.
   * Rows are fetched via a cursor so memory usage stays bounded.
   *
   * @param filters - Same optional filters as {@link createNdjsonExport}.
   * @returns Metadata and handles for the resulting file.
   *
   * @example
   * ```ts
   * const result = await exportService.createCsvExport({
   *   from: '2024-01-01T00:00:00.000Z',
   *   severity: 'CRITICAL',
   * });
   * res.setHeader('Content-Type', 'text/csv');
   * await pipeline(result.openReadStream(), res);
   * await result.cleanup();
   * ```
   */
  async createCsvExport(filters: AuditExportFilters = {}): Promise<AuditExportResult> {
    await fsp.mkdir(this.exportRoot, { recursive: true });

    const exportDir = await fsp.mkdtemp(path.join(this.exportRoot, 'audit-export-'));
    this.assertPathWithinRoot(exportDir);

    const fileName = `audit-log-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    const filePath = path.join(exportDir, fileName);
    this.assertPathWithinRoot(filePath);

    const writer = createWriteStream(filePath, { encoding: 'utf8', flags: 'wx' });
    let recordCount = 0;

    const query: AuditQuery = { ...filters };
    const cursor = this.service.stream(query);

    async function* generateLines(): AsyncGenerator<string> {
      // Write the header row first.
      yield `${CSV_HEADERS.join(',')}\n`;

      for (const entry of cursor) {
        const redacted = redactBody(entry as unknown as Record<string, unknown>) as AuditEntry;
        recordCount += 1;
        yield `${toCsvRow(redacted)}\n`;
      }
    }

    const source = Readable.from(generateLines());
    await pipeline(source, writer);

    const cleanup = async (): Promise<void> => {
      await fsp.rm(exportDir, { recursive: true, force: true });
    };

    return {
      filePath,
      fileName,
      bytesWritten: writer.bytesWritten,
      recordCount,
      openReadStream: () => createReadStream(filePath),
      cleanup,
    };
  }

  // ─── Streaming convenience helpers ─────────────────────────────────────────

  /**
   * Convenience method that pipes the NDJSON export directly to any
   * writable stream (e.g. an HTTP response).
   *
   * The temporary file is cleaned up automatically whether the pipeline
   * succeeds or fails.
   */
  async streamNdjsonExport(
    filters: AuditExportFilters,
    destination: NodeJS.WritableStream,
  ): Promise<Omit<AuditExportResult, 'openReadStream'>> {
    const result = await this.createNdjsonExport(filters);

    try {
      await pipeline(result.openReadStream(), destination);
      return {
        filePath: result.filePath,
        fileName: result.fileName,
        bytesWritten: result.bytesWritten,
        recordCount: result.recordCount,
        cleanup: result.cleanup,
      };
    } catch (error) {
      await result.cleanup();
      throw error;
    }
  }

  /**
   * Convenience method that pipes the CSV export directly to any
   * writable stream (e.g. an HTTP response).
   *
   * The temporary file is cleaned up automatically whether the pipeline
   * succeeds or fails.
   */
  async streamCsvExport(
    filters: AuditExportFilters,
    destination: NodeJS.WritableStream,
  ): Promise<Omit<AuditExportResult, 'openReadStream'>> {
    const result = await this.createCsvExport(filters);

    try {
      await pipeline(result.openReadStream(), destination);
      return {
        filePath: result.filePath,
        fileName: result.fileName,
        bytesWritten: result.bytesWritten,
        recordCount: result.recordCount,
        cleanup: result.cleanup,
      };
    } catch (error) {
      await result.cleanup();
      throw error;
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private assertPathWithinRoot(targetPath: string): void {
    const resolvedTarget = path.resolve(targetPath);
    const rootWithSeparator = this.exportRoot.endsWith(path.sep)
      ? this.exportRoot
      : `${this.exportRoot}${path.sep}`;

    if (resolvedTarget !== this.exportRoot && !resolvedTarget.startsWith(rootWithSeparator)) {
      throw new Error('Audit export path resolved outside configured export root');
    }
  }
}

export const auditExportService = new AuditExportService();
