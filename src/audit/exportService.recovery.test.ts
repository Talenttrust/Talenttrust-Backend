import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';

describe('NDJSON export artifact recovery', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it.each(['iterator acquisition', 'partial streaming'] as const)('removes incomplete files after %s failure and allows recovery', async phase => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'audit-recovery-test-'));
    const repository = new AuditStore();
    const service = new AuditService(repository);
    const entry = service.log({ action: 'USER_CREATED', severity: 'INFO', actor: 'user-1', resource: 'user', resourceId: 'user-1', metadata: {} });
    const exporter = new AuditExportService(service, { exportRoot: root });
    const failure = new Error('repository unavailable');
    const stream = jest.spyOn(service, 'stream');
    if (phase === 'iterator acquisition') {
      stream.mockImplementationOnce(() => { throw failure; });
    } else {
      stream.mockImplementationOnce(function* () {
        yield entry;
        throw failure;
      });
    }
    try {
      await expect(exporter.createNdjsonExport()).rejects.toBe(failure);
      expect(await fsp.readdir(root)).toEqual([]);
      expect(repository.getById(entry.id)).toBe(entry);
      expect(repository.verifyIntegrity().valid).toBe(true);
      const result = await exporter.createNdjsonExport();
      expect(result.recordCount).toBe(1);
      expect(await fsp.readFile(result.filePath, 'utf8')).toContain(entry.id);
      await result.cleanup();
      expect(await fsp.readdir(root)).toEqual([]);
    } finally {
      // Only the uniquely created test root is removed.
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('service rejection removes a fully generated artifact without deleting existing audit entries', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'audit-recovery-test-'));
    const repository = new AuditStore();
    const service = new AuditService(repository);
    const entry = service.log({ action: 'USER_CREATED', severity: 'INFO', actor: 'user-1', resource: 'user', resourceId: 'user-1', metadata: {} });
    const exporter = new AuditExportService(service, { exportRoot: root });
    const failure = new Error('compliance append unavailable');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(repository, 'append').mockImplementationOnce(() => { throw failure; });
    try {
      await expect(service.exportAuditLogs({}, { actor: 'admin' }, exporter)).rejects.toBe(failure);
      expect(await fsp.readdir(root)).toEqual([]);
      expect(repository.query()).toEqual([entry]);
      const result = await service.exportAuditLogs({}, { actor: 'admin' }, exporter);
      expect(repository.count()).toBe(2);
      expect(repository.verifyIntegrity().valid).toBe(true);
      await result.cleanup();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('retains the generation failure if artifact cleanup also fails and emits a safe diagnostic', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'audit-recovery-test-'));
    const service = new AuditService(new AuditStore());
    const exporter = new AuditExportService(service, { exportRoot: root });
    const failure = new Error('secret-generation');
    jest.spyOn(service, 'stream').mockImplementationOnce(() => { throw failure; });
    const remove = jest.spyOn(fsp, 'rm').mockRejectedValueOnce(new Error('secret-cleanup'));
    const diagnostic = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(exporter.createNdjsonExport()).rejects.toBe(failure);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith('[AuditExportService] Failed to clean up incomplete NDJSON export');
      expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/secret-generation|secret-cleanup/);
    } finally {
      remove.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
