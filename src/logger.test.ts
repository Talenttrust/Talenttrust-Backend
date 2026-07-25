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

import { Logger, createLogger, logger, createRequestLogger, LogLevel, LogRecord, setWriteRecordImpl, writeRecord } from './logger';
import { requestContextStore } from './middleware/requestContext';

// ── Logger – initial default writer ──────────────────────────────────────────

describe('Logger – initial default writer', () => {
  it('default writeRecordImpl writes to stdout or stderr', () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      writeRecord({
        timestamp: '2026-06-27T00:00:00.000Z',
        level: 'info',
        message: 'stdout test',
        service: 'talenttrust-backend'
      });
      expect(stdoutSpy).toHaveBeenCalled();
      
      writeRecord({
        timestamp: '2026-06-27T00:00:00.000Z',
        level: 'error',
        message: 'stderr test',
        service: 'talenttrust-backend'
      });
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CapturedLog {
  level: string;
  msg: string;
  service: string;
  timestamp?: string;
  [key: string]: any;
}

// Simple test helper that creates a logger with a custom write stream
function createTestLogger(): {
  logger: Logger;
  logs: CapturedLog[];
  restore: () => void;
} {
  const logs: CapturedLog[] = [];
  
  // Create a custom write function that captures logs
  const writeFn = (record: LogRecord) => {
    // Map LogRecord to CapturedLog format
    const { message, level, service, requestId, correlationId, timestamp, ...rest } = record;
    const capturedLog: CapturedLog = {
      level,
      msg: message, // Map message to msg
      service,
      timestamp,
      ...rest // Include any other fields except the ones we already mapped
    };
    
    // Only add requestId and correlationId if they actually exist
    if (requestId !== undefined) {
      (capturedLog as any).requestId = requestId;
    }
    if (correlationId !== undefined) {
      (capturedLog as any).correlationId = correlationId;
    }
    logs.push(capturedLog);
  };
  
  // Override the writeRecord implementation
  setWriteRecordImpl(writeFn);
  
  // Create a logger instance
  const testLogger = new Logger();
  
  return { 
    logger: testLogger, 
    logs,
    restore: () => {
      // Restore the default implementation
      setWriteRecordImpl((record: LogRecord) => {
        const line = JSON.stringify(record);
        if (record.level === 'error') {
          process.stderr.write(line + '\n');
        } else {
          process.stdout.write(line + '\n');
        }
      });
    }
  };
}

// ── Logger – base fields ──────────────────────────────────────────────────────

describe('Logger – base fields', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };
  let log: Logger;

  beforeEach(() => {
    testLogger = createTestLogger();
    log = testLogger.logger;
  });

  afterEach(() => {
    testLogger.restore();
  });

  it('includes mandatory fields on every record', () => {
    log.info('hello');
    const rec = testLogger.logs[0]!;
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.service).toBe('talenttrust-backend');
    expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // ISO format
  });

  it('omits requestId / correlationId when not set', () => {
    log.info('no ids');
    const rec = testLogger.logs[0]!;
    expect(rec.requestId).toBeUndefined();
    expect(rec.correlationId).toBeUndefined();
    expect('requestId' in rec).toBe(false);
    expect('correlationId' in rec).toBe(false);
  });

  it('debug routes correctly', () => {
    log.debug('d');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('debug');
    expect(testLogger.logs[0]!.msg).toBe('d');
  });

  it('warn routes correctly', () => {
    log.warn('w');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('warn');
    expect(testLogger.logs[0]!.msg).toBe('w');
  });

  it('error routes correctly', () => {
    log.error('e');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('error');
    expect(testLogger.logs[0]!.msg).toBe('e');
  });

  
  it('merges extra fields into the record', () => {
    log.info('ctx', { userId: 'u1', action: 'login' });
    const rec = testLogger.logs[0]!;
    expect(rec['userId']).toBe('u1');
    expect(rec['action']).toBe('login');
    expect(rec.msg).toBe('ctx');
  });

  it('deletes undefined properties from log record', () => {
    log.info('test undefined', { undefinedProp: undefined });
    const rec = testLogger.logs[0]!;
    expect('undefinedProp' in rec).toBe(false);
  });
});

// ── Logger – child context ────────────────────────────────────────────────────

describe('Logger – child context', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };

  beforeEach(() => { testLogger = createTestLogger(); });
  afterEach(() => { testLogger.restore(); });

  it('child logger includes requestId on every record', () => {
    const child = testLogger.logger.child({ requestId: 'req-abc' });
    child.info('from child');
    expect(testLogger.logs[0]!['requestId']).toBe('req-abc');
    expect(testLogger.logs[0]!.msg).toBe('from child');
  });

  it('child logger includes correlationId on every record', () => {
    const child = testLogger.logger.child({ requestId: 'r', correlationId: 'c-123' });
    child.warn('corr');
    expect(testLogger.logs[0]!['correlationId']).toBe('c-123');
    expect(testLogger.logs[0]!.msg).toBe('corr');
  });

  it('child context does not bleed into parent', () => {
    const parent = testLogger.logger;
    parent.child({ requestId: 'child-only' });
    parent.info('parent msg');
    expect(testLogger.logs[0]).not.toHaveProperty('requestId');
    expect(testLogger.logs[0]!.msg).toBe('parent msg');
  });

  it('grandchild merges all ancestor contexts', () => {
    const child = testLogger.logger.child({ requestId: 'r1' });
    const grandchild = child.child({ correlationId: 'c1', extra: 'x' });
    grandchild.info('deep');
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('r1');
    expect(rec['correlationId']).toBe('c1');
    expect(rec['extra']).toBe('x');
    expect(rec.msg).toBe('deep');
  });

  it('child extra fields override parent context fields', () => {
    const child = testLogger.logger.child({ requestId: 'old' });
    const grandchild = child.child({ requestId: 'new' });
    grandchild.info('override');
    expect(testLogger.logs[0]!['requestId']).toBe('new');
    expect(testLogger.logs[0]!.msg).toBe('override');
  });
});

// ── Logger – sensitive key redaction ─────────────────────────────────────────

describe('Logger – sensitive key redaction', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };

  beforeEach(() => { testLogger = createTestLogger(); });
  afterEach(() => { testLogger.restore(); });

  const sensitiveKeys = [
    'password', 'secret', 'token', 'authorization',
    'cookie', 'privateKey', 'mnemonic', 'seed', 'email',
    'credit_card', 'ssn', 'api_key'
  ];

  it.each(sensitiveKeys)('redacts "%s" field', (key: string) => {
    testLogger.logger.info('sensitive', { [key]: 'super-secret-value' });
    expect(testLogger.logs[0]![key]).toBe('[REDACTED]');
    expect(testLogger.logs[0]!.msg).toBe('sensitive');
  });

  it('redacts nested sensitive fields', () => {
    testLogger.logger.info('nested', { 
      user: { 
        password: 'hunter2', 
        email: 'user@example.com',
        name: 'alice' 
      } 
    });
    const user = testLogger.logs[0]!['user'] as Record<string, unknown>;
    expect(user['password']).toBe('[REDACTED]');
    expect(user['email']).toBe('[REDACTED]');
    expect(user['name']).toBe('alice');
    expect(testLogger.logs[0]!.msg).toBe('nested');
  });

  it('preserves non-sensitive fields', () => {
    testLogger.logger.info('safe', { userId: 'u1', action: 'view' });
    expect(testLogger.logs[0]!['userId']).toBe('u1');
    expect(testLogger.logs[0]!['action']).toBe('view');
    expect(testLogger.logs[0]!.msg).toBe('safe');
  });
});

// ── Logger – error serialisation ─────────────────────────────────────────────

describe('Logger – error serialisation', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };

  beforeEach(() => { testLogger = createTestLogger(); });
  afterEach(() => { testLogger.restore(); });

  it('serialises Error objects passed as err field', () => {
    const err = new Error('something broke');
    testLogger.logger.error('oops', { err });
    const rec = testLogger.logs[0]!;
    const serialised = rec['err'] as Record<string, unknown>;
    expect(serialised['type']).toBe('Error');
    expect(serialised['message']).toBe('something broke');
    expect(rec.msg).toBe('oops');
  });

  it('includes stack in non-production', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    
    const err = new Error('with stack');
    testLogger.logger.error('e', { err });
    const serialised = testLogger.logs[0]!['err'] as Record<string, unknown>;
    expect(typeof serialised['stack']).toBe('string');
    expect(testLogger.logs[0]!.msg).toBe('e');
    
    process.env.NODE_ENV = origEnv;
  });

  it('handles non-Error err field gracefully', () => {
    testLogger.logger.error('e', { err: 'string error' });
    expect(testLogger.logs[0]!['err']).toBe('string error');
    expect(testLogger.logs[0]!.msg).toBe('e');
  });
});

// ── createLogger factory ──────────────────────────────────────────────────────

describe('createLogger', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };

  beforeEach(() => { testLogger = createTestLogger(); });
  afterEach(() => { testLogger.restore(); });

  it('returns a Logger instance', () => {
    expect(createLogger()).toBeInstanceOf(Logger);
  });

  it('binds supplied context', () => {
    const log = createLogger({ requestId: 'factory-req' });
    log.info('from factory');
    expect(testLogger.logs[0]!['requestId']).toBe('factory-req');
    expect(testLogger.logs[0]!.msg).toBe('from factory');
  });
});

// ── default logger singleton ──────────────────────────────────────────────────

describe('default logger singleton', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };

  beforeEach(() => { testLogger = createTestLogger(); });
  afterEach(() => { testLogger.restore(); });

  it('is a Logger instance', () => {
    expect(logger).toBeInstanceOf(Logger);
  });

  it('logs without throwing', () => {
    expect(() => testLogger.logger.info('singleton test')).not.toThrow();
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.msg).toBe('singleton test');
  });
});

// ── createRequestLogger utility ───────────────────────────────────────────────

describe('createRequestLogger', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };

  beforeEach(() => { testLogger = createTestLogger(); });
  afterEach(() => { testLogger.restore(); });

  it('creates a logger with request context', () => {
    const reqLogger = createRequestLogger('req-123', 'corr-456');
    reqLogger.info('request log');
    
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('req-123');
    expect(rec['correlationId']).toBe('corr-456');
    expect(rec.msg).toBe('request log');
  });

  it('works with just requestId', () => {
    const reqLogger = createRequestLogger('req-only');
    reqLogger.info('request log');
    
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('req-only');
    expect(rec['correlationId']).toBeUndefined();
    expect(rec.msg).toBe('request log');
  });
});

// ── Logger – AsyncLocalStorage integration ────────────────────────────────────

describe('Logger – AsyncLocalStorage integration', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[]; restore: () => void };

  beforeEach(() => { testLogger = createTestLogger(); });
  afterEach(() => {
    testLogger.restore();
    requestContextStore.disable();
  });

  it('automatically extracts requestId and correlationId from AsyncLocalStorage if not bound', () => {
    requestContextStore.run({ requestId: 'als-req-id', correlationId: 'als-corr-id' }, () => {
      testLogger.logger.info('als log');
    });

    expect(testLogger.logs).toHaveLength(1);
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('als-req-id');
    expect(rec['correlationId']).toBe('als-corr-id');
    expect(rec.msg).toBe('als log');
  });

  it('prioritizes bound child logger context over AsyncLocalStorage store', () => {
    const child = testLogger.logger.child({ requestId: 'bound-req', correlationId: 'bound-corr' });

    requestContextStore.run({ requestId: 'als-req-id', correlationId: 'als-corr-id' }, () => {
      child.info('override log');
    });

    expect(testLogger.logs).toHaveLength(1);
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('bound-req');
    expect(rec['correlationId']).toBe('bound-corr');
  });

  it('propagates context correctly across nested awaits', async () => {
    await requestContextStore.run({ requestId: 'async-req', correlationId: 'async-corr' }, async () => {
      testLogger.logger.info('before await');
      await new Promise((resolve) => setTimeout(resolve, 10));
      testLogger.logger.info('after await');
    });

    expect(testLogger.logs).toHaveLength(2);
    expect(testLogger.logs[0]!['requestId']).toBe('async-req');
    expect(testLogger.logs[1]!['requestId']).toBe('async-req');
    expect(testLogger.logs[0]!['correlationId']).toBe('async-corr');
    expect(testLogger.logs[1]!['correlationId']).toBe('async-corr');
  });

  it('does not leak request contexts concurrently', async () => {
    const runRequest = async (id: string) => {
      await requestContextStore.run({ requestId: `req-${id}`, correlationId: `corr-${id}` }, async () => {
        testLogger.logger.info(`start-${id}`);
        await new Promise((resolve) => setTimeout(resolve, id === 'A' ? 25 : 10));
        testLogger.logger.info(`end-${id}`);
      });
    };

    await Promise.all([runRequest('A'), runRequest('B')]);

    expect(testLogger.logs).toHaveLength(4);
    
    // Check logs for request A
    const aLogs = testLogger.logs.filter(l => l.msg.endsWith('-A'));
    expect(aLogs).toHaveLength(2);
    aLogs.forEach(l => {
      expect(l['requestId']).toBe('req-A');
      expect(l['correlationId']).toBe('corr-A');
    });

    // Check logs for request B
    const bLogs = testLogger.logs.filter(l => l.msg.endsWith('-B'));
    expect(bLogs).toHaveLength(2);
    bLogs.forEach(l => {
      expect(l['requestId']).toBe('req-B');
      expect(l['correlationId']).toBe('corr-B');
    });
  });

  it('uses safe default (no id) when running outside of request context', () => {
    testLogger.logger.info('no context');
    expect(testLogger.logs).toHaveLength(1);
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBeUndefined();
    expect(rec['correlationId']).toBeUndefined();
  });
});
