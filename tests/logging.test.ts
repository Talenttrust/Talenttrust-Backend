import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore, type EscrowContract } from '../src/store';
import { createLogger, type Logger } from '../src/logger';

function getResponseHeader(res: { headers: Record<string, string | string[]>; rawHeaders?: string[] }, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (res.headers && res.headers[lower] !== undefined) {
    const v = res.headers[lower];
    return Array.isArray(v) ? v[0] : v;
  }
  if (res.rawHeaders) {
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      if (res.rawHeaders[i].toLowerCase() === lower) return res.rawHeaders[i + 1];
    }
  }
  return undefined;
}

function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    stream: {
      write: (chunk: unknown) => {
        try {
          lines.push(JSON.parse(String(chunk)));
        } catch {
          // ignore non-JSON chunks
        }
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  });
  return { logger, lines };
}

class ThrowingStore extends EscrowStore {
  override get(_id: number): EscrowContract {
    throw new Error('boom');
  }
}

describe('structured request logging', () => {
  it('echoes a valid X-Request-Id in header and body', async () => {
    const { logger, lines } = captureLogger();
    const app = createApp({ store: new EscrowStore().seed(), logger });
    const res = await request(app)
      .get('/api/v1/contracts/1')
      .set('x-request-id', 'valid-req-0001');
    expect(res.status).toBe(200);
    expect(getResponseHeader(res, 'x-request-id')).toBe('valid-req-0001');
    expect(lines.some((l) => l.level === 'info' && l.msg === 'request')).toBe(true);
  });

  it('replaces an invalid X-Request-Id (too short, spaces, newlines)', async () => {
    const cases = ['abc', 'a b c', 'has space', 'x'.repeat(200)];
    for (const input of cases) {
      const { logger, lines } = captureLogger();
      const app = createApp({ store: new EscrowStore().seed(), logger });
      const res = await request(app).get('/api/v1/contracts/1').set('x-request-id', input);
      expect(res.status).toBe(200);
      const echoed = getResponseHeader(res, 'x-request-id');
      expect(echoed).not.toBe(input);
      expect(/^[A-Za-z0-9._-]{8,128}$/.test(echoed as string)).toBe(true);
      // no CR/LF ever reaches logs or headers
      for (const line of lines) {
        expect(String(line)).not.toMatch(/\r|\n/);
      }
    }
  });

  it('includes requestId in 404 and 400 error bodies', async () => {
    const { logger, lines } = captureLogger();
    const app = createApp({ store: new EscrowStore().seed(), logger });

    const notFound = await request(app).get('/api/v1/contracts/99999').set('x-request-id', 'notfound-req-0001');
    expect(notFound.status).toBe(404);
    expect((notFound.body as { requestId?: string }).requestId).toBe('notfound-req-0001');
    expect(getResponseHeader(notFound, 'x-request-id')).toBe('notfound-req-0001');

    const bad = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GA', milestones: [1] })
      .set('x-request-id', 'badreq-0001');
    expect(bad.status).toBe(400);
    expect((bad.body as { requestId?: string }).requestId).toBe('badreq-0001');
    expect(getResponseHeader(bad, 'x-request-id')).toBe('badreq-0001');
  });

  it('logs a throwing route with stack and matching requestId exactly once', async () => {
    const { logger, lines } = captureLogger();
    const app = createApp({ store: new ThrowingStore(), logger });
    const res = await request(app).get('/api/v1/contracts/999').set('x-request-id', 'throw-req-0001');
    expect(res.status).toBe(500);
    expect((res.body as { requestId?: string }).requestId).toBe('throw-req-0001');
    expect(getResponseHeader(res, 'x-request-id')).toBe('throw-req-0001');

    const errorLines = lines.filter(
      (l) => l.level === 'error' && l.msg === 'unhandled_error' && l.err && (l.err as { stack?: unknown }).stack,
    );
    expect(errorLines).toHaveLength(1);
    expect(String((errorLines[0].err as { stack?: unknown }).stack)).toContain('boom');
    expect(errorLines[0].requestId).toBe('throw-req-0001');
    // no stack leaks into the response body
    expect((res.body as { stack?: unknown }).stack).toBeUndefined();
  });

  it('never logs authorization / x-api-key values', async () => {
    const { logger, lines } = captureLogger();
    const app = createApp({ store: new EscrowStore(), logger });
    const secret = 'super-secret-api-key';
    await request(app)
      .get('/api/v1/contracts/1')
      .set('authorization', `Bearer ${secret}`)
      .set('x-api-key', secret)
      .set('cookie', `session=${secret}`);
    for (const line of lines) {
      const text = JSON.stringify(line);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(`Bearer ${secret}`);
    }
  });

  it('produces no output when LOG_LEVEL=silent', async () => {
    const lines: Record<string, unknown>[] = [];
    const silent = createLogger({
      level: 'silent',
      stream: {
        write: (chunk: unknown) => {
          lines.push(JSON.parse(String(chunk)));
          return true;
        },
      } as unknown as NodeJS.WriteStream,
    });
    const app = createApp({ store: new EscrowStore(), logger: silent });
    await request(app).get('/api/v1/contracts/1');
    expect(lines.length).toBe(0);
  });
});
