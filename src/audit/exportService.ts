import { createWriteStream, createReadStream } from 'fs';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';
import { tmpdir } from 'os';
import type { ReadStream } from 'fs';
import { AuditService, auditService } from './service';
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
}

export class AuditExportService {
  private readonly exportRoot: string;

  constructor(
    private readonly service: AuditService = auditService,
    options: AuditExportServiceOptions = {},
  ) {
    this.exportRoot = path.resolve(options.exportRoot ?? path.join(tmpdir(), 'talenttrust-audit-exports'));
  }

  async createNdjsonExport(query: AuditQuery = {}): Promise<AuditExportResult> {
    await mkdir(this.exportRoot, { recursive: true });

    const exportDir = await mkdtemp(path.join(this.exportRoot, 'audit-export-'));
    this.assertPathWithinRoot(exportDir);

    const fileName = `audit-log-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
    const filePath = path.join(exportDir, fileName);
    this.assertPathWithinRoot(filePath);

    const writer = createWriteStream(filePath, { encoding: 'utf8', flags: 'wx' });
    let recordCount = 0;
    const source = Readable.from((function* generateLines(entries: IterableIterator<AuditEntry>) {
      for (const entry of entries) {
        recordCount += 1;
        yield `${JSON.stringify(entry)}\n`;
      }
    })(this.service.stream(query)));

    await pipeline(source, writer);

    const cleanup = async (): Promise<void> => {
      await rm(exportDir, { recursive: true, force: true });
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

  async streamNdjsonExport(
    query: AuditQuery,
    destination: NodeJS.WritableStream,
  ): Promise<Omit<AuditExportResult, 'openReadStream'>> {
    const result = await this.createNdjsonExport(query);

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
