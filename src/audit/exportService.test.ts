import { existsSync, readFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';

describe('AuditExportService', () => {
  let store: AuditStore;
  let service: AuditService;
  let exportRoot: string;

  beforeEach(() => {
    store = new AuditStore();
    service = new AuditService(store);
    exportRoot = mkdtempSync(path.join(tmpdir(), 'audit-export-test-'));
  });

  afterEach(() => {
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('writes the export to a controlled directory and cleans it up', async () => {
    service.log({
      action: 'ADMIN_ACTION',
      severity: 'CRITICAL',
      actor: 'admin-1',
      resource: 'audit-log',
      resourceId: 'export',
      metadata: { test: true },
    });

    const exportService = new AuditExportService(service, { exportRoot });
    const result = await exportService.createNdjsonExport();

    expect(result.filePath.startsWith(path.resolve(exportRoot))).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);

    const fileContents = readFileSync(result.filePath, 'utf8');
    expect(fileContents).toContain('"action":"ADMIN_ACTION"');
    expect(result.recordCount).toBe(1);

    await result.cleanup();
    expect(existsSync(result.filePath)).toBe(false);
  });

  it('exports more than the normal paginated query limit for compliance downloads', async () => {
    for (let index = 0; index < 1005; index += 1) {
      service.log({
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: `user-${index}`,
        resource: 'contract',
        resourceId: `contract-${index}`,
        metadata: { index },
      });
    }

    const exportService = new AuditExportService(service, { exportRoot });
    const result = await exportService.createNdjsonExport();
    const lines = readFileSync(result.filePath, 'utf8').trim().split('\n');

    expect(lines).toHaveLength(1005);
    expect(result.recordCount).toBe(1005);

    await result.cleanup();
  });
});
