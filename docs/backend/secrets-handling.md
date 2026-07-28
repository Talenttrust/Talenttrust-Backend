# Secrets Handling

This document describes how the application loads, transforms, manages, and rotates secrets at runtime, and the security guarantees provided by the implementation.

---

## Overview

Secrets are managed through four constructs defined in `src/config/secrets.ts`:

| Construct | Description |
|---|---|
| `Secret<T>` | Interface: `get()` + `refresh()` |
| `EnvSecret<T>` | Loads from `process.env`; supports optional transform |
| `SecretsManager` | Registry that groups named secrets and bulk-refreshes them |
| `RotatingSecret<T>` | Async provider-backed secret with optional background polling |

All constructs implement the same `Secret<T>` interface, so they are interchangeable at call sites.

---

## API Reference

### `Secret<T>` interface

```typescript
interface Secret<T> {
  get(): T;
  refresh(): Promise<void>;
}
```

### `EnvSecret<T>`

Reads a value from `process.env` synchronously at construction time.

```typescript
constructor(
  key: string,              // environment variable name
  defaultValue?: T,         // fallback if the variable is absent
  transform?: (val: string) => T  // optional coercion / validation
)
```

- If the variable is absent **and** no `defaultValue` is provided, the constructor throws immediately (fail-fast).
- `refresh()` re-reads `process.env[key]` — useful when a sidecar updates environment variables at runtime.

### `SecretsManager`

```typescript
const manager = new SecretsManager();

manager.register('PORT', new EnvSecret<number>('PORT', 3001, Number));
manager.register('JWT_SECRET', new EnvSecret('JWT_SECRET'));

manager.getValue<number>('PORT');  // 3001
await manager.refreshAll();        // re-reads all registered secrets
manager.clear();                   // removes all registrations (useful in tests)
```

A default singleton `secretsManager` is exported and pre-populated by `initializeSecrets()`.

### `RotatingSecret<T>`

Fetches a secret from an async `provider` function and caches the last successful value.

```typescript
const secret = new RotatingSecret({
  provider: async () => fetchFromVault('my-api-key'),
  transform: (raw) => JSON.parse(raw),
  defaultValue: undefined,
  refreshIntervalMs: 60_000,  // background refresh every minute
  name: 'my-api-key',         // used in log messages only (never the value)
});

await secret.refresh();        // manual first fetch
secret.get();                  // returns cached value synchronously

secret.stopAutoRefresh();      // stops background timer (call in tests/shutdown)
```

On refresh failure the previous value is retained (fail-safe) and only a minimal warning — containing the secret **name**, never its value — is written to the logger.

---

## Transform Error Redaction Guarantee

### The Problem

The `transform` callback receives the raw secret string. If the callback throws an error that echoes its input (e.g. a JSON parser that includes the malformed token in the message), a naive implementation would propagate the raw value into `error.message`, then into startup logs and stack traces.

### The Fix

`EnvSecret.load()` wraps `transform` in a catch block that **discards** the original error completely:

```typescript
} catch {
  // Never include the original error message or any derivative of the raw
  // secret value in the thrown error — a thrown parser error can echo its
  // input.  Only the key name is safe to surface here.
  throw new Error(
    `Configuration Error: Failed to transform secret "${this.key}" — transform threw an error (details omitted to protect secret value)`
  );
}
```

The re-thrown error contains **only the key name**. It never includes:

- `error.message`
- `String(error)`
- `JSON.stringify(error)`
- Any other serialisation of the caught error object

This means the raw secret value cannot leak into logs regardless of what the transform throws.

### What This Covers

| Transform throws | Secret value leaks? |
|---|---|
| `new Error(\`parse failed near: \${rawValue}\`)` | No — original message discarded |
| `throw rawValue` (plain string) | No — string not serialised |
| `throw { code: 'ERR', input: rawValue }` (object) | No — object not serialised |
| `throw null` / `throw undefined` | No — nothing to serialise |
| Nothing (success path) | N/A |

The catch block intentionally uses the binding-free `catch {` form (no `catch (e)`) so it is
syntactically impossible to reference the caught value, making accidental leakage a compile-time
error rather than a runtime risk.

### Tests

`src/config/secrets.test.ts` contains a dedicated `'transform error redaction'` suite that
asserts all four throw variants above produce error messages that contain neither the raw secret
value nor any 4-character substring of it.

---

## Usage Examples

### Simple string secret

```typescript
import { EnvSecret } from './config/secrets';

const jwtSecret = new EnvSecret('JWT_SECRET');
jwtSecret.get(); // raw string
```

### Numeric secret with transform

```typescript
const port = new EnvSecret<number>('PORT', 3001, (v) => {
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error('PORT must be a number');
  return n;
});
// If parseInt throws or returns NaN, the error message will NOT contain the raw value of PORT
```

### JSON-structured secret

```typescript
interface DbConfig { host: string; port: number; }

const dbConfig = new EnvSecret<DbConfig>('DB_CONFIG', undefined, (raw) => {
  // JSON.parse may throw with the raw string in its message — this is safe
  // because EnvSecret will discard that error before re-throwing.
  return JSON.parse(raw) as DbConfig;
});
```

### Rotating secret with background refresh

```typescript
import { RotatingSecret } from './config/secrets';

const signingKey = new RotatingSecret({
  provider: async () => {
    const res = await fetch('https://vault.internal/v1/secret/signing-key');
    return (await res.json()).data.value as string;
  },
  refreshIntervalMs: 5 * 60 * 1000, // every 5 minutes
  name: 'signing-key',
});

await signingKey.refresh(); // initial fetch before serving traffic
```

---

## Security Notes

1. **Never log `secret.get()`** — pass the value only to the library/function that needs it.
2. **Transform errors are safe to log** — the re-thrown error from `EnvSecret` contains only the key name.
3. **`RotatingSecret` refresh failures** are logged at `warn` level with only the secret name, never its value.
4. **Default values in production** — secrets with development defaults (`JWT_SECRET`, `DATABASE_URL`) must be overridden via environment variables before deploying to production. The application does not enforce this automatically; use infrastructure-level checks (e.g., CI env-var validation) to catch missing production secrets early.
5. **`redactSecret` from `src/utils/redact.ts`** can be used at any call site to replace a secret value with `[REDACTED]` before it reaches a logger or response body.

```typescript
import { redactSecret } from '../utils/redact';

logger.info('Using signing key', { key: redactSecret(signingKey.get()) });
// logs: { key: '[REDACTED]' }
```

4. Update `.env.example` with the new variable (without real values)
5. Update this documentation to include the new secret in the Registered Secrets table

## Testing

Comprehensive tests are located in `src/config/secrets.test.ts`. These tests cover:
- Successful loading from environment variables
- Usage of default values
- Error handling for missing required secrets
- Type transformation logic
- Secret rotation/refreshing
- `SecretsManager` registration and retrieval
- `RotatingSecret` fail-safe behavior

# Secrets Handling

## Required secrets

`JWT_SECRET` and `DATABASE_URL` are **required outside `development`/`test`**.
If either is missing when `NODE_ENV` is `production` or `staging`, the app
throws at boot (`initializeSecrets()` in `src/config/secrets.ts`) instead of
silently falling back to a committed default.

## JWT_SECRET rules

- Required in production/staging (no fallback).
- Must be at least 32 characters.
- The known development placeholder (`dev-secret-keep-it-safe`) is rejected
  even if explicitly set — it's committed to source, so anyone can forge a
  valid JWT if it's ever used outside development.

## DATABASE_URL rules

- Required in production/staging (no fallback).
- The known development placeholder
  (`postgresql://localhost:5432/talenttrust`) is rejected even if explicitly
  set, for the same reason.

## Why fail-fast

A missing or placeholder secret in production is a silent security hole —
the app boots fine, but auth tokens (or DB access) are signed/secured with a
value anyone can find in the repo. Failing at boot turns that into an
immediately visible deploy failure instead of a live vulnerability.

## Local development

In `development` and `test`, both secrets fall back to their documented
defaults automatically — no setup needed. See `.env.example`.

