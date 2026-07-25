/**
 * @file secrets.test.ts
 * @description Unit tests for EnvSecret, SecretsManager, and the
 * transform-error redaction guarantee.
 *
 * Security contract under test:
 *   When an EnvSecret transform callback throws — regardless of whether it
 *   throws an Error, a plain string, or any other value — the resulting
 *   error message MUST NOT contain the raw secret value or any substring of
 *   it.  Only the environment-variable key name may appear.
 */

import { EnvSecret, SecretsManager, initializeSecrets, secretsManager } from './secrets';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RAW_SECRET = 'super-secret-password-12345';
const KEY = 'TEST_TRANSFORM_SECRET';

function withEnv(key: string, value: string, fn: () => void): void {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

// ---------------------------------------------------------------------------
// EnvSecret — basic behaviour
// ---------------------------------------------------------------------------

describe('EnvSecret — basic behaviour', () => {
  it('returns the raw env value when no transform is supplied', () => {
    withEnv(KEY, 'hello', () => {
      const s = new EnvSecret(KEY);
      expect(s.get()).toBe('hello');
    });
  });

  it('applies the transform and returns the transformed value', () => {
    withEnv(KEY, '42', () => {
      const s = new EnvSecret<number>(KEY, undefined, (v) => parseInt(v, 10));
      expect(s.get()).toBe(42);
    });
  });

  it('uses the default value when the env var is absent', () => {
    delete process.env[KEY];
    const s = new EnvSecret(KEY, 'default-val');
    expect(s.get()).toBe('default-val');
  });

  it('throws when the env var is absent and no default is provided', () => {
    delete process.env[KEY];
    expect(() => new EnvSecret(KEY)).toThrow(
      `Configuration Error: Missing required secret "${KEY}"`
    );
  });

  it('refresh() re-reads the env var', async () => {
    const prev = process.env[KEY];
    try {
      process.env[KEY] = 'first';
      const s = new EnvSecret(KEY);
      expect(s.get()).toBe('first');

      process.env[KEY] = 'second';
      await s.refresh();
      expect(s.get()).toBe('second');
    } finally {
      if (prev === undefined) {
        delete process.env[KEY];
      } else {
        process.env[KEY] = prev;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// EnvSecret — transform error REDACTION guarantee
// ---------------------------------------------------------------------------

describe('EnvSecret — transform error redaction', () => {
  /**
   * Core invariant: the thrown message must name the key but MUST NOT
   * contain the raw secret value (or any contiguous substring ≥ 4 chars that
   * is not already present in the key name itself).
   *
   * We exclude substrings that also appear in KEY from the check because the
   * key name is intentionally included in the error message for debuggability,
   * and a chunk like "secr" (from "TEST_TRANSFORM_SECRET") should not be
   * flagged as a leak of the raw secret value.
   */
  function assertRedacted(error: unknown, secretValue: string): void {
    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;

    // Must name the key for debuggability
    expect(msg).toContain(KEY);

    // Must NOT contain the full secret value
    expect(msg).not.toContain(secretValue);

    // Stricter: no 4-char substring of the secret that is NOT also part of the
    // key name should appear in the error message.
    for (let i = 0; i <= secretValue.length - 4; i++) {
      const chunk = secretValue.slice(i, i + 4);
      // Skip this chunk if it already appears in the key name — its presence
      // in the message is explained by the key being named, not by the secret
      // value leaking.
      if (KEY.includes(chunk)) continue;
      expect(msg).not.toContain(chunk);
    }
  }

  it('does NOT leak the secret when transform throws an Error whose message contains the raw value', () => {
    withEnv(KEY, RAW_SECRET, () => {
      const leakyTransform = (val: string) => {
        throw new Error(`Invalid format: received "${val}"`);
      };
      let caught: unknown;
      try {
        new EnvSecret(KEY, undefined, leakyTransform);
      } catch (e) {
        caught = e;
      }
      assertRedacted(caught, RAW_SECRET);
    });
  });

  it('does NOT leak the secret when transform throws the raw secret string directly', () => {
    withEnv(KEY, RAW_SECRET, () => {
      const leakyTransform = (val: string) => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw val; // throws the raw secret as a plain string
      };
      let caught: unknown;
      try {
        new EnvSecret(KEY, undefined, leakyTransform);
      } catch (e) {
        caught = e;
      }
      assertRedacted(caught, RAW_SECRET);
    });
  });

  it('does NOT leak the secret when transform throws a non-Error object containing the value', () => {
    withEnv(KEY, RAW_SECRET, () => {
      const leakyTransform = (val: string) => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw { code: 'PARSE_ERROR', input: val }; // object with secret
      };
      let caught: unknown;
      try {
        new EnvSecret(KEY, undefined, leakyTransform);
      } catch (e) {
        caught = e;
      }
      assertRedacted(caught, RAW_SECRET);
    });
  });

  it('does NOT leak the secret when transform throws null', () => {
    withEnv(KEY, RAW_SECRET, () => {
      const leakyTransform = (_val: string) => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw null;
      };
      let caught: unknown;
      try {
        new EnvSecret(KEY, undefined, leakyTransform);
      } catch (e) {
        caught = e;
      }
      assertRedacted(caught, RAW_SECRET);
    });
  });

  it('does NOT leak the secret when transform throws undefined', () => {
    withEnv(KEY, RAW_SECRET, () => {
      const leakyTransform = (_val: string) => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw undefined;
      };
      let caught: unknown;
      try {
        new EnvSecret(KEY, undefined, leakyTransform);
      } catch (e) {
        caught = e;
      }
      assertRedacted(caught, RAW_SECRET);
    });
  });

  it('error message contains the safe boilerplate text', () => {
    withEnv(KEY, RAW_SECRET, () => {
      let caught: unknown;
      try {
        new EnvSecret(KEY, undefined, () => { throw new Error('boom'); });
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toMatch(
        /Configuration Error: Failed to transform secret/
      );
      expect((caught as Error).message).toMatch(/details omitted/);
    });
  });

  it('still throws (fail-fast contract is preserved)', () => {
    withEnv(KEY, RAW_SECRET, () => {
      expect(() => {
        new EnvSecret(KEY, undefined, () => { throw new Error('bad'); });
      }).toThrow();
    });
  });

  it('does NOT throw when transform succeeds — happy path is unaffected', () => {
    withEnv(KEY, '100', () => {
      expect(() => {
        new EnvSecret<number>(KEY, undefined, (v) => parseInt(v, 10));
      }).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// SecretsManager
// ---------------------------------------------------------------------------

describe('SecretsManager', () => {
  let mgr: SecretsManager;

  beforeEach(() => {
    mgr = new SecretsManager();
    withEnv('MGR_TEST_KEY', 'mgr-val', () => {
      mgr.register('mySecret', new EnvSecret('MGR_TEST_KEY'));
    });
  });

  it('getValue returns the registered secret value', () => {
    withEnv('MGR_TEST_KEY', 'mgr-val', () => {
      const m = new SecretsManager();
      m.register('mySecret', new EnvSecret('MGR_TEST_KEY'));
      expect(m.getValue('mySecret')).toBe('mgr-val');
    });
  });

  it('throws when getting an unregistered secret', () => {
    expect(() => mgr.getValue('nonexistent')).toThrow(
      'SecretsManager Error: Secret "nonexistent" not found.'
    );
  });

  it('throws when registering the same name twice', () => {
    withEnv('MGR_TEST_KEY', 'x', () => {
      expect(() => mgr.register('mySecret', new EnvSecret('MGR_TEST_KEY'))).toThrow(
        'SecretsManager Error: Secret "mySecret" is already registered.'
      );
    });
  });

  it('clear() removes all secrets', () => {
    mgr.clear();
    expect(() => mgr.getValue('mySecret')).toThrow();
  });

  it('refreshAll() resolves without error', async () => {
    const prev = process.env['MGR_TEST_KEY'];
    try {
      process.env['MGR_TEST_KEY'] = 'refreshed';
      const m = new SecretsManager();
      m.register('s', new EnvSecret('MGR_TEST_KEY'));
      await expect(m.refreshAll()).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env['MGR_TEST_KEY'];
      } else {
        process.env['MGR_TEST_KEY'] = prev;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// initializeSecrets / global secretsManager
// ---------------------------------------------------------------------------

describe('initializeSecrets', () => {
  afterEach(() => {
    // restore application secrets so other tests are not affected
    initializeSecrets();
  });

  it('re-initialises without throwing (idempotent via clear)', () => {
    expect(() => initializeSecrets()).not.toThrow();
  });

  it('registers PORT with correct default', () => {
    initializeSecrets();
    expect(secretsManager.getValue<number>('PORT')).toBe(
      process.env.PORT ? parseInt(process.env.PORT, 10) : 3001
    );
  });

  it('registers NODE_ENV with correct default', () => {
    initializeSecrets();
    const env = secretsManager.getValue<string>('NODE_ENV');
    expect(typeof env).toBe('string');
  });
});
