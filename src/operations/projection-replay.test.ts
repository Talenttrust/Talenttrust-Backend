import { ProjectionReplayer, ProjectionEvent } from './projection-replay';

describe('ProjectionReplayer', () => {
  let replayer: ProjectionReplayer;

  beforeEach(() => {
    replayer = new ProjectionReplayer();
  });

  it('handles empty range', () => {
    const result = replayer.replay({ events: [] });
    expect(result.status).toBe('success');
    expect(result.after?.version).toBe(0);
  });

  it('handles duplicate events', () => {
    const events: ProjectionEvent[] = [
      { id: '1', type: 'test', payload: { a: 1 }, timestamp: 100 },
      { id: '1', type: 'test', payload: { a: 2 }, timestamp: 200 },
    ];
    const result = replayer.replay({ events });
    expect(result.status).toBe('success');
    expect(result.after?.version).toBe(1);
    expect(result.after?.data.a).toBe(1);
  });

  it('handles unknown schema', () => {
    const events: ProjectionEvent[] = [
      { id: '1', type: '', payload: { a: 1 }, timestamp: 100 }
    ];
    const result = replayer.replay({ events });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Unknown schema/);
  });

  it('replays against current state', () => {
    const events: ProjectionEvent[] = [
      { id: '1', type: 'test', payload: { b: 2 }, timestamp: 100 }
    ];
    const initialState = { version: 5, data: { a: 1 } };
    const result = replayer.replay({ events, initialState });
    expect(result.status).toBe('success');
    expect(result.after?.version).toBe(6);
    expect(result.after?.data).toEqual({ a: 1, b: 2 });
  });

  it('enforces tenant isolation', () => {
    const events: ProjectionEvent[] = [
      { id: '1', type: 'test', tenantId: 'tenant-a', payload: { a: 1 }, timestamp: 100 }
    ];
    const result = replayer.replay({ events, tenantId: 'tenant-b' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Tenant isolation violation/);
  });

  it('redacts sensitive payloads', () => {
    const events: ProjectionEvent[] = [
      { id: '1', type: 'test', payload: { authorization: 'secret-token', a: 1 }, timestamp: 100 }
    ];
    const result = replayer.replay({ events });
    expect(result.status).toBe('success');
    expect(result.after?.data.authorization).toBe('[REDACTED]');
    expect(result.after?.data.a).toBe(1);
  });

  it('handles large range', () => {
    const events: ProjectionEvent[] = Array.from({ length: 1000 }).map((_, i) => ({
      id: `evt-${i}`,
      type: 'test',
      payload: { [`k-${i}`]: i },
      timestamp: i
    }));
    const result = replayer.replay({ events });
    expect(result.status).toBe('success');
    expect(result.after?.version).toBe(1000);
    expect(Object.keys(result.after!.data).length).toBe(1000);
  });
});
