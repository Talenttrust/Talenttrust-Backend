/**
 * Unit tests for src/logger.ts (Pino-based implementation)
 *
 * Coverage targets:
 *   - Record shape and mandatory fields
 *   - Child logger context merging
 *   - Sensitive-key redaction (Pino redaction)
 *   - Error serialisation (with/without stack)
 *   - Log levels and routing
 *   - createLogger factory
 *   - Request logger utility
 */

import { Logger, createLogger, logger, createRequestLogger, LogLevel } from './logger';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CapturedLog {
  level: string;
  message: string;
  service: string;
  time?: number;
  requestId?: string;
  correlationId?: string;
  [key: string]: any;
}

function captureLogs(): {
  logs: CapturedLog[];
  restore: () => void;
} {
  const logs: CapturedLog[] = [];
  
  // Mock the write function to capture logs
  const originalWrite = process.stdout.write;
  const mockWrite = jest.fn().mockImplementation((chunk: any) => {
    try {
      const logLine = chunk.toString().trim();
      if (logLine) {
        const parsed = JSON.parse(logLine) as CapturedLog;
        logs.push(parsed);
      }
      return true;
    } catch (error) {
      return true;
    }
  });

  process.stdout.write = mockWrite;

  return {
    logs,
    restore: () => {
      process.stdout.write = originalWrite;
    }
  };
}

// ── Logger – base fields ──────────────────────────────────────────────────────

describe('Logger – base fields', () => {
  let cap: ReturnType<typeof captureLogs>;
  let log: Logger;

  beforeEach(() => {
    cap = captureLogs();
    log = new Logger();
  });
  afterEach(() => cap.restore());

  it('includes mandatory fields on every record', () => {
    log.info('hello');
    const rec = cap.logs[0]!;
    expect(rec.level).toBe('info');
    expect(rec.message).toBe('hello');
    expect(rec.service).toBe('talenttrust-backend');
    expect(typeof rec.time).toBe('number');
    expect(rec.time).toBeGreaterThan(0);
  });

  it('omits requestId / correlationId when not set', () => {
    log.info('no ids');
    const rec = cap.logs[0]!;
    expect(rec).not.toHaveProperty('requestId');
    expect(rec).not.toHaveProperty('correlationId');
  });

  it('debug routes correctly', () => {
    log.debug('d');
    expect(cap.logs).toHaveLength(1);
    expect(cap.logs[0]!.level).toBe('debug');
  });

  it('warn routes correctly', () => {
    log.warn('w');
    expect(cap.logs).toHaveLength(1);
    expect(cap.logs[0]!.level).toBe('warn');
  });

  it('error routes correctly', () => {
    log.error('e');
    expect(cap.logs).toHaveLength(1);
    expect(cap.logs[0]!.level).toBe('error');
  });

  it('fatal routes correctly', () => {
    log.fatal('f');
    expect(cap.logs).toHaveLength(1);
    expect(cap.logs[0]!.level).toBe('fatal');
  });

  it('trace routes correctly', () => {
    log.trace('t');
    expect(cap.logs).toHaveLength(1);
    expect(cap.logs[0]!.level).toBe('trace');
  });

  it('merges extra fields into the record', () => {
    log.info('ctx', { userId: 'u1', action: 'login' });
    const rec = cap.logs[0]!;
    expect(rec['userId']).toBe('u1');
    expect(rec['action']).toBe('login');
  });
});

// ── Logger – child context ────────────────────────────────────────────────────

describe('Logger – child context', () => {
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => { cap = captureLogs(); });
  afterEach(() => cap.restore());

  it('child logger includes requestId on every record', () => {
    const child = new Logger().child({ requestId: 'req-abc' });
    child.info('from child');
    expect(cap.logs[0]!['requestId']).toBe('req-abc');
  });

  it('child logger includes correlationId on every record', () => {
    const child = new Logger().child({ requestId: 'r', correlationId: 'c-123' });
    child.warn('corr');
    expect(cap.logs[0]!['correlationId']).toBe('c-123');
  });

  it('child context does not bleed into parent', () => {
    const parent = new Logger();
    parent.child({ requestId: 'child-only' });
    parent.info('parent msg');
    expect(cap.logs[0]).not.toHaveProperty('requestId');
  });

  it('grandchild merges all ancestor contexts', () => {
    const child = new Logger().child({ requestId: 'r1' });
    const grandchild = child.child({ correlationId: 'c1', extra: 'x' });
    grandchild.info('deep');
    const rec = cap.logs[0]!;
    expect(rec['requestId']).toBe('r1');
    expect(rec['correlationId']).toBe('c1');
    expect(rec['extra']).toBe('x');
  });

  it('child extra fields override parent context fields', () => {
    const child = new Logger().child({ requestId: 'old' });
    const grandchild = child.child({ requestId: 'new' });
    grandchild.info('override');
    expect(cap.logs[0]!['requestId']).toBe('new');
  });
});

// ── Logger – sensitive key redaction ─────────────────────────────────────────

describe('Logger – sensitive key redaction', () => {
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => { cap = captureLogs(); });
  afterEach(() => cap.restore());

  const sensitiveKeys = [
    'password', 'secret', 'token', 'authorization',
    'cookie', 'privateKey', 'mnemonic', 'seed', 'email',
    'credit_card', 'ssn', 'api_key'
  ];

  it.each(sensitiveKeys)('redacts "%s" field', (key: string) => {
    const log = new Logger();
    log.info('sensitive', { [key]: 'super-secret-value' });
    expect(cap.logs[0]![key]).toBe('[REDACTED]');
  });

  it('redacts nested sensitive fields', () => {
    const log = new Logger();
    log.info('nested', { 
      user: { 
        password: 'hunter2', 
        email: 'user@example.com',
        name: 'alice' 
      } 
    });
    const user = cap.logs[0]!['user'] as Record<string, unknown>;
    expect(user['password']).toBe('[REDACTED]');
    expect(user['email']).toBe('[REDACTED]');
    expect(user['name']).toBe('alice');
  });

  it('preserves non-sensitive fields', () => {
    const log = new Logger();
    log.info('safe', { userId: 'u1', action: 'view' });
    expect(cap.logs[0]!['userId']).toBe('u1');
  });
});

// ── Logger – error serialisation ─────────────────────────────────────────────

describe('Logger – error serialisation', () => {
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => { cap = captureLogs(); });
  afterEach(() => cap.restore());

  it('serialises Error objects passed as err field', () => {
    const log = new Logger();
    const err = new Error('something broke');
    log.error('oops', { err });
    const rec = cap.logs[0]!;
    const serialised = rec['err'] as Record<string, unknown>;
    expect(serialised['type']).toBe('Error');
    expect(serialised['message']).toBe('something broke');
  });

  it('includes stack in non-production', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    
    const log = new Logger();
    const err = new Error('with stack');
    log.error('e', { err });
    const serialised = cap.logs[0]!['err'] as Record<string, unknown>;
    expect(typeof serialised['stack']).toBe('string');
    
    process.env.NODE_ENV = origEnv;
  });

  it('handles non-Error err field gracefully', () => {
    const log = new Logger();
    log.error('e', { err: 'string error' });
    expect(cap.logs[0]!['err']).toBe('string error');
  });
});

// ── createLogger factory ──────────────────────────────────────────────────────

describe('createLogger', () => {
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => { cap = captureLogs(); });
  afterEach(() => cap.restore());

  it('returns a Logger instance', () => {
    expect(createLogger()).toBeInstanceOf(Logger);
  });

  it('binds supplied context', () => {
    const log = createLogger({ requestId: 'factory-req' });
    log.info('from factory');
    expect(cap.logs[0]!['requestId']).toBe('factory-req');
  });
});

// ── default logger singleton ──────────────────────────────────────────────────

describe('default logger singleton', () => {
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => { cap = captureLogs(); });
  afterEach(() => cap.restore());

  it('is a Logger instance', () => {
    expect(logger).toBeInstanceOf(Logger);
  });

  it('logs without throwing', () => {
    expect(() => logger.info('singleton test')).not.toThrow();
    expect(cap.logs).toHaveLength(1);
  });
});

// ── createRequestLogger utility ───────────────────────────────────────────────

describe('createRequestLogger', () => {
  let cap: ReturnType<typeof captureLogs>;

  beforeEach(() => { cap = captureLogs(); });
  afterEach(() => cap.restore());

  it('creates a logger with request context', () => {
    const reqLogger = createRequestLogger('req-123', 'corr-456');
    reqLogger.info('request log');
    
    const rec = cap.logs[0]!;
    expect(rec['requestId']).toBe('req-123');
    expect(rec['correlationId']).toBe('corr-456');
  });

  it('works with just requestId', () => {
    const reqLogger = createRequestLogger('req-only');
    reqLogger.info('request log');
    
    const rec = cap.logs[0]!;
    expect(rec['requestId']).toBe('req-only');
    expect(rec['correlationId']).toBeUndefined();
  });
});
