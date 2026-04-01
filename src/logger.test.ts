/**
 * Unit tests for src/logger.ts
 *
 * Coverage targets:
 *   - Record shape and mandatory fields
 *   - Child logger context merging
 *   - Sensitive-key redaction
 *   - Error serialisation (with/without stack)
 *   - stdout vs stderr routing
 *   - createLogger factory
 */

import { Logger, createLogger, logger, writeRecord, LogRecord } from './logger';

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureWrites(): {
  stdout: LogRecord[];
  stderr: LogRecord[];
  restore: () => void;
} {
  const stdout: LogRecord[] = [];
  const stderr: LogRecord[] = [];

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  const spyOut = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdout.push(JSON.parse(chunk as string) as LogRecord);
      return true;
    });

  const spyErr = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderr.push(JSON.parse(chunk as string) as LogRecord);
      return true;
    });

  return {
    stdout,
    stderr,
    restore: () => {
      spyOut.mockRestore();
      spyErr.mockRestore();
      void origOut;
      void origErr;
    },
  };
}

// ── writeRecord ───────────────────────────────────────────────────────────────

describe('writeRecord', () => {
  it('writes non-error levels to stdout', () => {
    const { stdout, stderr, restore } = captureWrites();
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'test',
      service: 'talenttrust-backend',
    };
    writeRecord(record);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);
    restore();
  });

  it('writes error level to stderr', () => {
    const { stdout, stderr, restore } = captureWrites();
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'boom',
      service: 'talenttrust-backend',
    };
    writeRecord(record);
    expect(stderr).toHaveLength(1);
    expect(stdout).toHaveLength(0);
    restore();
  });
});

// ── Logger – base fields ──────────────────────────────────────────────────────

describe('Logger – base fields', () => {
  let cap: ReturnType<typeof captureWrites>;
  let log: Logger;

  beforeEach(() => {
    cap = captureWrites();
    log = new Logger();
  });
  afterEach(() => cap.restore());

  it('includes mandatory fields on every record', () => {
    log.info('hello');
    const rec = cap.stdout[0]!;
    expect(rec.level).toBe('info');
    expect(rec.message).toBe('hello');
    expect(rec.service).toBe('talenttrust-backend');
    expect(typeof rec.timestamp).toBe('string');
    expect(new Date(rec.timestamp).toISOString()).toBe(rec.timestamp);
  });

  it('omits requestId / correlationId when not set', () => {
    log.info('no ids');
    const rec = cap.stdout[0]!;
    expect(rec).not.toHaveProperty('requestId');
    expect(rec).not.toHaveProperty('correlationId');
  });

  it('debug routes to stdout', () => {
    log.debug('d');
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]!.level).toBe('debug');
  });

  it('warn routes to stdout', () => {
    log.warn('w');
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]!.level).toBe('warn');
  });

  it('error routes to stderr', () => {
    log.error('e');
    expect(cap.stderr).toHaveLength(1);
    expect(cap.stderr[0]!.level).toBe('error');
  });

  it('merges extra fields into the record', () => {
    log.info('ctx', { userId: 'u1', action: 'login' });
    const rec = cap.stdout[0]!;
    expect(rec['userId']).toBe('u1');
    expect(rec['action']).toBe('login');
  });
});

// ── Logger – child context ────────────────────────────────────────────────────

describe('Logger – child context', () => {
  let cap: ReturnType<typeof captureWrites>;

  beforeEach(() => { cap = captureWrites(); });
  afterEach(() => cap.restore());

  it('child logger includes requestId on every record', () => {
    const child = new Logger().child({ requestId: 'req-abc' });
    child.info('from child');
    expect(cap.stdout[0]!['requestId']).toBe('req-abc');
  });

  it('child logger includes correlationId on every record', () => {
    const child = new Logger().child({ requestId: 'r', correlationId: 'c-123' });
    child.warn('corr');
    expect(cap.stdout[0]!['correlationId']).toBe('c-123');
  });

  it('child context does not bleed into parent', () => {
    const parent = new Logger();
    parent.child({ requestId: 'child-only' });
    parent.info('parent msg');
    expect(cap.stdout[0]).not.toHaveProperty('requestId');
  });

  it('grandchild merges all ancestor contexts', () => {
    const child = new Logger().child({ requestId: 'r1' });
    const grandchild = child.child({ correlationId: 'c1', extra: 'x' });
    grandchild.info('deep');
    const rec = cap.stdout[0]!;
    expect(rec['requestId']).toBe('r1');
    expect(rec['correlationId']).toBe('c1');
    expect(rec['extra']).toBe('x');
  });

  it('child extra fields override parent context fields', () => {
    const child = new Logger().child({ requestId: 'old' });
    const grandchild = child.child({ requestId: 'new' });
    grandchild.info('override');
    expect(cap.stdout[0]!['requestId']).toBe('new');
  });
});

// ── Logger – sensitive key redaction ─────────────────────────────────────────

describe('Logger – sensitive key redaction', () => {
  let cap: ReturnType<typeof captureWrites>;

  beforeEach(() => { cap = captureWrites(); });
  afterEach(() => cap.restore());

  const sensitiveKeys = [
    'password', 'secret', 'token', 'authorization',
    'cookie', 'privateKey', 'mnemonic', 'seed',
  ];

  it.each(sensitiveKeys)('redacts "%s" field', (key) => {
    const log = new Logger();
    log.info('sensitive', { [key]: 'super-secret-value' });
    expect(cap.stdout[0]![key]).toBe('[REDACTED]');
  });

  it('redacts nested sensitive fields', () => {
    const log = new Logger();
    log.info('nested', { user: { password: 'hunter2', name: 'alice' } });
    const user = cap.stdout[0]!['user'] as Record<string, unknown>;
    expect(user['password']).toBe('[REDACTED]');
    expect(user['name']).toBe('alice');
  });

  it('preserves non-sensitive fields', () => {
    const log = new Logger();
    log.info('safe', { userId: 'u1', action: 'view' });
    expect(cap.stdout[0]!['userId']).toBe('u1');
  });
});

// ── Logger – error serialisation ─────────────────────────────────────────────

describe('Logger – error serialisation', () => {
  let cap: ReturnType<typeof captureWrites>;
  const origEnv = process.env['NODE_ENV'];

  beforeEach(() => { cap = captureWrites(); });
  afterEach(() => {
    cap.restore();
    process.env['NODE_ENV'] = origEnv;
  });

  it('serialises Error objects passed as err field', () => {
    const log = new Logger();
    const err = new Error('something broke');
    log.error('oops', { err });
    const rec = cap.stderr[0]!;
    const serialised = rec['err'] as Record<string, unknown>;
    expect(serialised['name']).toBe('Error');
    expect(serialised['message']).toBe('something broke');
  });

  it('includes stack in non-production', () => {
    process.env['NODE_ENV'] = 'test';
    const log = new Logger();
    const err = new Error('with stack');
    log.error('e', { err });
    const serialised = cap.stderr[0]!['err'] as Record<string, unknown>;
    expect(typeof serialised['stack']).toBe('string');
  });

  it('omits stack in production', () => {
    process.env['NODE_ENV'] = 'production';
    const log = new Logger();
    const err = new Error('prod error');
    log.error('e', { err });
    const serialised = cap.stderr[0]!['err'] as Record<string, unknown>;
    expect(serialised['stack']).toBeUndefined();
  });

  it('handles non-Error err field gracefully', () => {
    const log = new Logger();
    log.error('e', { err: 'string error' });
    expect(cap.stderr[0]!['err']).toBe('string error');
  });
});

// ── createLogger factory ──────────────────────────────────────────────────────

describe('createLogger', () => {
  let cap: ReturnType<typeof captureWrites>;

  beforeEach(() => { cap = captureWrites(); });
  afterEach(() => cap.restore());

  it('returns a Logger instance', () => {
    expect(createLogger()).toBeInstanceOf(Logger);
  });

  it('binds supplied context', () => {
    const log = createLogger({ requestId: 'factory-req' });
    log.info('from factory');
    expect(cap.stdout[0]!['requestId']).toBe('factory-req');
  });
});

// ── default logger singleton ──────────────────────────────────────────────────

describe('default logger singleton', () => {
  let cap: ReturnType<typeof captureWrites>;

  beforeEach(() => { cap = captureWrites(); });
  afterEach(() => cap.restore());

  it('is a Logger instance', () => {
    expect(logger).toBeInstanceOf(Logger);
  });

  it('logs without throwing', () => {
    expect(() => logger.info('singleton test')).not.toThrow();
    expect(cap.stdout).toHaveLength(1);
  });
});
