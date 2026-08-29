/**
 * Job Quarantine Store + Failure Classification Unit Tests
 *
 * Covers the durable store (add/inspect/replay/evict/redaction/tenant) and the
 * terminal-vs-transient classifier, both backed by the in-memory SQLite mock.
 */

import { Registry } from 'prom-client';
import { JobType } from './types';
import {
  JobQuarantineStorage,
  clearJobQuarantineInstance,
  getJobQuarantineStorage,
  initializeJobQuarantineMetrics,
  resetJobQuarantineMetrics,
} from './job-quarantine';
import {
  InvalidJobPayloadError,
  StaleJobReferenceError,
  TerminalJobError,
  classifyFailure,
  terminalKindOf,
} from './queue-errors';
import { redactPayload } from '../utils/redact';

const SECRET_BEARING_PAYLOAD = {
  contractId: 'contract-test-123',
  action: 'create',
  secret: 'sk_live_123',
  token: 'tok-abc',
  metadata: { apiKey: 'key-abc' },
} as never;

describe('classifyFailure', () => {
  it('classifies TerminalJobError subclasses as terminal', () => {
    expect(classifyFailure(new InvalidJobPayloadError('bad'))).toBe('terminal');
    expect(classifyFailure(new StaleJobReferenceError('gone'))).toBe('terminal');
    expect(classifyFailure(new TerminalJobError('x', 'y'))).toBe('terminal');
  });

  it('classifies ordinary transient errors as transient', () => {
    expect(classifyFailure(new Error('upstream 500'))).toBe('transient');
    expect(classifyFailure('not an error')).toBe('transient');
    expect(classifyFailure(undefined)).toBe('transient');
  });

  it('resolves terminal kind and null for non-terminal', () => {
    expect(terminalKindOf(new InvalidJobPayloadError('bad'))).toBe('invalid_payload');
    expect(terminalKindOf(new StaleJobReferenceError('gone'))).toBe('stale_reference');
    expect(terminalKindOf(new Error('transient'))).toBeNull();
  });
});

describe('JobQuarantineStorage', () => {
  let storage: JobQuarantineStorage;
  let registry: Registry;

  beforeEach(() => {
    clearJobQuarantineInstance();
    resetJobQuarantineMetrics();
    registry = new Registry();
    initializeJobQuarantineMetrics(registry);
    storage = new JobQuarantineStorage(':memory:', {
      maxCapacity: 3,
      maxReplayAttempts: 2,
    });
  });

  afterEach(() => {
    clearJobQuarantineInstance();
    resetJobQuarantineMetrics();
  });

  function addTerminal(input: Partial<Parameters<JobQuarantineStorage['addEntry']>[0]> = {}) {
    return storage.addEntry({
      jobType: JobType.CONTRACT_PROCESSING,
      jobId: 'job-1',
      tenantId: 'tenant-1',
      payload: { contractId: 'abc', action: 'create' } as never,
      reason: 'Invalid contract ID',
      kind: 'invalid_payload',
      attemptsMade: 1,
      ...input,
    });
  }

  it('persists an entry with redacted payload and sanitized reason', async () => {
    const id = await storage.addEntry({
      jobType: JobType.CONTRACT_PROCESSING,
      jobId: 'job-secret',
      payload: SECRET_BEARING_PAYLOAD,
      reason: 'Invalid contract ID',
      kind: 'invalid_payload',
      attemptsMade: 0,
    });

    const entry = storage.getEntry(id);

    // Redaction: secrets are scrubbed from the persisted payload.
    const persisted = entry!.payload as Record<string, unknown>;
    expect(persisted.secret).toBe('[REDACTED]');
    expect(persisted.token).toBe('[REDACTED]');
    expect((persisted.metadata as Record<string, unknown>).apiKey).toBe('[REDACTED]');

    expect(entry!.reason).toBe('Invalid contract ID');
    expect(entry!.kind).toBe('invalid_payload');
    expect(entry!.tenantId).toBe('default');
    expect(entry!.replayAttempts).toBe(0);
  });

  it('defaults tenantId to the default tenant when omitted', async () => {
    const id = await addTerminal({ tenantId: undefined });
    expect(storage.getEntry(id)!.tenantId).toBe('default');
  });

  it('filters by tenantId and jobType', async () => {
    await addTerminal({ jobId: 'a', tenantId: 'tenant-x' });
    await addTerminal({ jobId: 'b', tenantId: 'tenant-y' });

    expect(storage.listEntries({ tenantId: 'tenant-x' })).toHaveLength(1);
    expect(storage.listEntries({ jobType: JobType.CONTRACT_PROCESSING })).toHaveLength(2);
    expect(storage.listEntries({ jobType: JobType.EMAIL_NOTIFICATION })).toHaveLength(0);
  });

  it('evicts the oldest pending entry when at capacity', async () => {
    const id1 = await addTerminal({ jobId: '1' });
    await addTerminal({ jobId: '2' });
    await addTerminal({ jobId: '3' });
    const id4 = await addTerminal({ jobId: '4' });

    expect(storage.getEntry(id1)).toBeNull();
    expect(storage.getEntry(id4)).not.toBeNull();
    expect((await storage.getStats()).pending).toBe(3);
  });

  it('does not evict replayed entries, only pending ones', async () => {
    const id1 = await addTerminal({ jobId: '1' });
    await addTerminal({ jobId: '2' });
    await addTerminal({ jobId: '3' });

    storage.markReplayed(id1);
    const id4 = await addTerminal({ jobId: '4' });

    expect(storage.getEntry(id1)).not.toBeNull();
    expect(storage.getEntry(id4)).not.toBeNull();
  });

  it('increments replay attempts and flags max-exceeded at the bound', async () => {
    const id = await addTerminal({ jobId: 'r' });

    const first = storage.incrementReplayAttempts(id);
    expect(first).toEqual({ success: true, attempts: 1, maxExceeded: false });

    const second = storage.incrementReplayAttempts(id);
    expect(second).toEqual({ success: true, attempts: 2, maxExceeded: true });

    expect(storage.getEntry(id)).not.toBeNull();
  });

  it('returns failure for replay attempts on a missing entry', () => {
    expect(storage.incrementReplayAttempts('missing')).toEqual({
      success: false,
      attempts: 0,
      maxExceeded: false,
    });
  });

  it('getPayload reconstructs jobType, tenant, and redacted payload', async () => {
    const id = await addTerminal({
      jobId: 'orig-42',
      tenantId: 'tenant-p',
      payload: SECRET_BEARING_PAYLOAD,
    });

    const p = storage.getPayload(id)!;
    expect(p.jobType).toBe(JobType.CONTRACT_PROCESSING);
    expect(p.jobId).toBe('orig-42');
    expect(p.tenantId).toBe('tenant-p');
    expect((p.payload as Record<string, unknown>).secret).toBe('[REDACTED]');
  });

  it('records enqueue metrics on add', async () => {
    await addTerminal({ jobId: 'metric' });
    const metrics = await registry.getSingleMetricAsString('job_quarantine_operations_total');
    expect(metrics).toContain('enqueue');
  });

  it('exposes the shared instance getter (singleton under test)', () => {
    const a = getJobQuarantineStorage();
    const b = getJobQuarantineStorage();
    expect(a).toBe(b);
  });
});

describe('redactPayload integration', () => {
  it('recursively redacts sensitive keys in nested payloads', () => {
    const out = redactPayload({
      secret: 'x',
      token: 'y',
      nested: { apiKey: 'z', keep: 'ok' },
      list: [{ password: 'p', name: 'n' }],
    }) as Record<string, unknown>;
    expect(out.secret).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).keep).toBe('ok');
    expect(((out.list as Record<string, unknown>[])[0]).password).toBe('[REDACTED]');
  });
});