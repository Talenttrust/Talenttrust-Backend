import { AuditService } from './service';
import { AuditStore } from './store';
import { AuditCache } from './auditCache';
import type { AuditExportService, AuditExportResult } from './exportService';
import type { CreateAuditEntryInput } from './types';

const input: CreateAuditEntryInput = {
  action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user-1',
  resource: 'contract', resourceId: 'contract-1', metadata: {},
};

function fixture() {
  const repository = new AuditStore();
  const service = new AuditService(repository, { cache: { ttlMs: 60_000, maxEntries: 10 } });
  return { repository, service };
}

function exportFixture() {
  const results: AuditExportResult[] = [];
  const exporter = {
    createNdjsonExport: jest.fn().mockImplementation(async () => {
      const result = {
        filePath: `/tmp/export-${results.length}.ndjson`, fileName: 'export.ndjson',
        recordCount: 1, bytesWritten: 100,
        openReadStream: jest.fn(), cleanup: jest.fn().mockResolvedValue(undefined),
      };
      results.push(result);
      return result;
    }),
  };
  return { results, exporter: exporter as unknown as AuditExportService };
}

describe('AuditService deterministic failure recovery', () => {
  let diagnostics: jest.SpyInstance;
  beforeEach(() => { diagnostics = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('invalidates unfiltered, actor/action, resource and cursor snapshots after append', () => {
    const { service, repository } = fixture();
    const filters = [{}, { actor: input.actor }, { action: input.action }, { resourceId: input.resourceId }];
    for (const query of filters) {
      expect(service.query(query)).toEqual([]);
      expect(service.queryWithCursor(query).entries).toEqual([]);
    }
    const entry = service.log(input);
    for (const query of filters) {
      expect(service.query(query)).toEqual([entry]);
      expect(service.queryWithCursor(query).entries).toEqual([entry]);
    }
    expect(repository.verifyIntegrity().valid).toBe(true);
  });

  it('returns a committed write exactly once when invalidation fails and bypasses stale data', () => {
    const { service, repository } = fixture();
    service.query();
    const invalidate = jest.spyOn(AuditCache.prototype, 'invalidate').mockImplementation(() => { throw new Error('secret-cache'); });
    const append = jest.spyOn(repository, 'append');
    const entry = service.log(input);
    expect(append).toHaveBeenCalledTimes(1);
    expect(repository.count()).toBe(1);
    expect(service.query()).toEqual([entry]);
    service.log({ ...input, resourceId: 'contract-2' });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(repository.count()).toBe(2);
    expect(repository.verifyIntegrity().valid).toBe(true);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret-cache');
  });

  it.each(['query', 'queryWithCursor', 'getById'] as const)('%s falls back to the repository after cache get failure', method => {
    const { service, repository } = fixture();
    const entry = service.log(input);
    const get = jest.spyOn(AuditCache.prototype, 'get').mockImplementation(() => { throw new Error('secret-read'); });
    const read = () => method === 'getById' ? service.getById(entry.id) : service[method]();
    const expected = method === 'getById' ? entry : method === 'query' ? [entry] : repository.queryWithCursor();
    expect(read()).toEqual(expected);
    expect(read()).toEqual(expected);
    expect(get).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret-read');
  });

  it.each(['query', 'queryWithCursor', 'getById'] as const)('%s preserves a successful read after cache set failure', method => {
    const { service, repository } = fixture();
    const entry = service.log(input);
    const set = jest.spyOn(AuditCache.prototype, 'set').mockImplementation(() => { throw new Error('secret-write'); });
    const read = () => method === 'getById' ? service.getById(entry.id) : service[method]();
    const expected = method === 'getById' ? entry : method === 'query' ? [entry] : repository.queryWithCursor();
    expect(read()).toEqual(expected);
    expect(read()).toEqual(expected);
    expect(set).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret-write');
  });

  it('propagates the original persistence failure without retry and recovers on the next call', () => {
    const { service, repository } = fixture();
    const existing = service.log(input);
    const failure = new Error('secret-database');
    const append = jest.spyOn(repository, 'append').mockImplementationOnce(() => { throw failure; });
    expect(() => service.log(input)).toThrow(failure);
    expect(append).toHaveBeenCalledTimes(1);
    expect(repository.count()).toBe(1);
    service.log(input);
    expect(repository.count()).toBe(2);
    expect(repository.getById(existing.id)).toBe(existing);
    expect(repository.verifyIntegrity().valid).toBe(true);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret-database');
  });

  it('invalidates a snapshot after an ambiguous append failure without implicitly retrying', () => {
    const { service, repository } = fixture();
    service.query();
    const append = repository.append.bind(repository);
    const spy = jest.spyOn(repository, 'append').mockImplementation(payload => {
      append(payload);
      throw new Error('ambiguous commit');
    });
    expect(() => service.log(input)).toThrow('ambiguous commit');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(service.query()).toHaveLength(1);
  });

  it('preserves commit and failure outcomes even when diagnostics throw', () => {
    const { service, repository } = fixture();
    diagnostics.mockImplementation(() => { throw new Error('diagnostic failure'); });
    jest.spyOn(AuditCache.prototype, 'invalidate').mockImplementation(() => { throw new Error('cache failure'); });
    expect(service.log(input).id).toBeDefined();
    const failure = new Error('repository failure');
    jest.spyOn(repository, 'append').mockImplementationOnce(() => { throw failure; });
    expect(() => service.log(input)).toThrow(failure);
  });

  it('does not swallow repository read failures or serve a stale success', () => {
    const { service, repository } = fixture();
    jest.spyOn(AuditCache.prototype, 'get').mockImplementation(() => { throw new Error('cache failure'); });
    jest.spyOn(repository, 'query').mockImplementationOnce(() => { throw new Error('repository unavailable'); });
    expect(() => service.query()).toThrow('repository unavailable');
    expect(service.query()).toEqual([]);
  });

  it('retains validation rejection before persistence and export creation', async () => {
    const { service, repository } = fixture();
    const { exporter } = exportFixture();
    expect(() => service.createEntry({ ...input, actor: '' })).toThrow('Missing required fields');
    await expect(service.exportAuditLogs({ limit: '0' }, {}, exporter)).rejects.toThrow('Invalid limit');
    expect(repository.count()).toBe(0);
    expect(exporter.createNdjsonExport).not.toHaveBeenCalled();
  });

  it('cleans up a rejected export, preserves existing entries, and allows an explicit retry', async () => {
    const { service, repository } = fixture();
    const existing = service.log(input);
    const { exporter, results } = exportFixture();
    const failure = new Error('secret-persistence');
    jest.spyOn(repository, 'append').mockImplementationOnce(() => { throw failure; });
    await expect(service.exportAuditLogs({}, { actor: 'admin' }, exporter)).rejects.toBe(failure);
    expect(results[0].cleanup).toHaveBeenCalledTimes(1);
    expect(repository.getById(existing.id)).toBe(existing);
    expect(repository.count()).toBe(1);
    const result = await service.exportAuditLogs({}, { actor: 'admin' }, exporter);
    expect(result).toBe(results[1]);
    expect(result.cleanup).not.toHaveBeenCalled();
    expect(repository.count()).toBe(2);
    expect(repository.verifyIntegrity().valid).toBe(true);
  });

  it('preserves the primary export error if cleanup also fails without leaking either error', async () => {
    const { service, repository } = fixture();
    const { exporter, results } = exportFixture();
    const failure = new Error('secret-append');
    jest.spyOn(repository, 'append').mockImplementationOnce(() => { throw failure; });
    const pending = service.exportAuditLogs({}, {}, exporter);
    // The exporter resolves asynchronously; its result already belongs only to this call.
    (results[0].cleanup as jest.Mock).mockRejectedValue(new Error('secret-cleanup'));
    await expect(pending).rejects.toBe(failure);
    expect(results[0].cleanup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/secret-append|secret-cleanup/);
  });

  it('does not append when the export dependency fails, and can recover', async () => {
    const { service, repository } = fixture();
    const { exporter } = exportFixture();
    const failure = new Error('export failed');
    (exporter.createNdjsonExport as jest.Mock).mockRejectedValueOnce(failure);
    await expect(service.exportAuditLogs({}, {}, exporter)).rejects.toBe(failure);
    expect(repository.count()).toBe(0);
    await service.exportAuditLogs({}, {}, exporter);
    expect(repository.count()).toBe(1);
  });

  it('concurrent export attempts clean up only the failed call and retain the successful result', async () => {
    const { service, repository } = fixture();
    const { exporter, results } = exportFixture();
    jest.spyOn(repository, 'append').mockImplementationOnce(() => { throw new Error('first append failed'); });
    const outcomes = await Promise.allSettled([
      service.exportAuditLogs({}, { actor: 'admin-1' }, exporter),
      service.exportAuditLogs({}, { actor: 'admin-2' }, exporter),
    ]);
    expect(outcomes[0].status).toBe('rejected');
    expect(outcomes[1]).toEqual({ status: 'fulfilled', value: results[1] });
    expect(results[0].cleanup).toHaveBeenCalledTimes(1);
    expect(results[1].cleanup).not.toHaveBeenCalled();
    expect(repository.query()[0].actor).toBe('admin-2');
    expect(repository.verifyIntegrity().valid).toBe(true);
  });
});
