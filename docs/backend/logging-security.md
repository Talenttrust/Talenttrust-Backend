# Logging Security — Comprehensive Redaction

## Overview

The logging system automatically redacts sensitive data before it reaches any log transport layer. This ensures that secrets (Stellar seeds, HMAC keys, Bearer tokens) are never exposed in logs, even if developers accidentally log them.

---

## Target Patterns

### 1. Stellar Secret Seeds

**Pattern:** `S[A-Z2-7]{55}` (56 characters total, base32 alphabet)

**Example:**
```
SALAACGR7QWWI7WQMXLA7YJKHQWZQMQOCQBJXTQXCWZGM7QWWI7WQMXLA
```

**Redacted Output:**
```
[REDACTED_STELLAR_SECRET]
```

**CRITICAL:** Stellar public keys (starting with `G`) are **NOT** redacted. Public keys are safe to log and are essential for debugging.

**Example (Public Key — NOT Redacted):**
```
GALAACGR7QWWI7WQMXLA7YJKHQWZQMQOCQBJXTQXCWZGM7QWWI7WQMXLA
```

---

### 2. Webhook HMAC Secrets

**Key Names (Case-Insensitive):**
- `secret`
- `signing_key`
- `webhook_secret`
- `hmac_secret`
- `api_secret`
- `client_secret`
- `consumer_secret`

**Behavior:** Any value associated with these keys is redacted.

**Example:**
```typescript
logger.log('Webhook config', {
  url: 'https://example.com/hook',
  signing_key: 'a'.repeat(64), // HMAC secret
});

// Output:
// Webhook config { url: 'https://example.com/hook', signing_key: '[REDACTED]' }
```

---

### 3. Bearer Tokens

**Pattern:** `Bearer <token>` where token is base64url-encoded (JWT/OAuth).

**Example:**
```
Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U
```

**Redacted Output:**
```
Bearer [REDACTED_TOKEN]
```

**Key Names (Case-Insensitive):**
- `authorization`
- `token`
- `access_token`
- `refresh_token`
- `bearer`
- `oauth_token`
- `session_token`

---

### 4. Generic Secrets

**Key Names (Case-Insensitive):**
- `password`
- `passwd`
- `pwd`
- `api_key`
- `apikey`
- `private_key`
- `privatekey`

**Long Secrets (40+ Characters):**
Any string of 40+ base64/hex characters is redacted (unless it's a Stellar public key).

**Example:**
```typescript
logger.log('API key', { api_key: 'sk_live_1234567890abcdef' });

// Output:
// API key { api_key: '[REDACTED]' }
```

---

## Integration Mechanism

### Centralized Logger

**Replace all `console.log`, `console.error`, `console.warn` calls with:**

```typescript
import { logger } from './logger';

// Before (UNSAFE):
console.log('User secret:', stellarSecret);

// After (SAFE):
logger.log('User secret:', stellarSecret);
// Output: User secret: [REDACTED_STELLAR_SECRET]
```

### Automatic Redaction

All arguments passed to `logger.log`, `logger.error`, `logger.warn` are automatically redacted before being written to the console.

**Example:**
```typescript
logger.log('Webhook delivery', {
  providerId: 'acme',
  secret: 'SALAACGR7QWWI7WQMXLA7YJKHQWZQMQOCQBJXTQXCWZGM7QWWI7WQMXLA',
  publicKey: 'GALAACGR7QWWI7WQMXLA7YJKHQWZQMQOCQBJXTQXCWZGM7QWWI7WQMXLA',
});

// Output:
// Webhook delivery {
//   providerId: 'acme',
//   secret: '[REDACTED]',
//   publicKey: 'GALAACGR7QWWI7WQMXLA7YJKHQWZQMQOCQBJXTQXCWZGM7QWWI7WQMXLA'
// }
```

---

## Deep Traversal

The redaction utility recursively traverses deeply nested objects, arrays, and error objects.

### Nested Objects

```typescript
logger.log('User data', {
  user: {
    profile: {
      stellarAccount: {
        publicKey: 'G...',
        secretKey: 'S...', // Redacted
      },
    },
  },
});

// Output:
// User data {
//   user: {
//     profile: {
//       stellarAccount: {
//         publicKey: 'G...',
//         secretKey: '[REDACTED_STELLAR_SECRET]'
//       }
//     }
//   }
// }
```

### Error Objects

```typescript
const error = new Error('Authentication failed with secret: S...');
logger.error('Error occurred', error);

// Output:
// Error occurred {
//   name: 'Error',
//   message: 'Authentication failed with secret: [REDACTED_STELLAR_SECRET]',
//   stack: '...' // Stack trace also redacted
// }
```

### Stack Traces

```typescript
const error = new Error('Test error');
error.stack = `Error: Test error
    at processEvent (idempotency.ts:100:20)
    Secret seed: SALAACGR7QWWI7WQMXLA7YJKHQWZQMQOCQBJXTQXCWZGM7QWWI7WQMXLA`;

logger.error('Stack trace', error);

// Output:
// Stack trace {
//   name: 'Error',
//   message: 'Test error',
//   stack: 'Error: Test error\n    at processEvent (idempotency.ts:100:20)\n    Secret seed: [REDACTED_STELLAR_SECRET]'
// }
```

---

## Registering New Sensitive Keys

Developers can register custom sensitive keys that should always be redacted:

```typescript
import { registerSensitiveKey } from './redact';

// Register a new sensitive key
registerSensitiveKey('my_custom_secret');

// Now this key will be redacted
logger.log('Config', { my_custom_secret: 'value123' });
// Output: Config { my_custom_secret: '[REDACTED]' }
```

**Recommended Keys to Register:**
- Custom API keys (e.g., `stripe_secret_key`, `twilio_auth_token`)
- Database credentials (e.g., `db_password`, `redis_password`)
- Third-party service secrets (e.g., `sendgrid_api_key`, `aws_secret_key`)

---

## Performance Considerations

### Recursion Depth Limit

**Max Depth:** 20 levels

Objects nested deeper than 20 levels are replaced with `[MAX_DEPTH_EXCEEDED]` to prevent stack overflow.

**Example:**
```typescript
// Create a deeply nested object (25 levels)
let obj = { value: 'deep' };
for (let i = 0; i < 25; i++) {
  obj = { nested: obj };
}

logger.log('Deep object', obj);
// Output: Deep object { nested: { nested: ... { nested: [MAX_DEPTH_EXCEEDED] } } }
```

---

### Circular Reference Detection

Circular references are detected using a `WeakSet` and replaced with `[CIRCULAR_REFERENCE]`.

**Example:**
```typescript
const obj = { name: 'test' };
obj.self = obj; // Circular reference

logger.log('Circular object', obj);
// Output: Circular object { name: 'test', self: '[CIRCULAR_REFERENCE]' }
```

---

### String Length Optimization

Strings shorter than 10 characters skip regex redaction (performance optimization).

**Rationale:** Secrets are typically 40+ characters. Short strings are unlikely to contain secrets.

---

### Lazy Regex Compilation

All regex patterns are compiled once at module load time and reused for all redaction operations.

**Patterns:**
- `STELLAR_SECRET_REGEX`: `/S[A-Z2-7]{55}/g`
- `STELLAR_PUBLIC_REGEX`: `/G[A-Z2-7]{55}/g`
- `BEARER_TOKEN_REGEX`: `/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi`
- `LONG_SECRET_REGEX`: `/[A-Za-z0-9+/=]{40,}/g`

---

## Migration Guide

### Step 1: Replace `console.log` with `logger.log`

**Before:**
```typescript
console.log('[webhookDelivery] Delivered', { providerId, secret });
```

**After:**
```typescript
import { logger } from './logger';

logger.log('[webhookDelivery] Delivered', { providerId, secret });
```

---

### Step 2: Replace `console.error` with `logger.error`

**Before:**
```typescript
console.error('[idempotency] Side effect failed:', err);
```

**After:**
```typescript
import { logger } from './logger';

logger.error('[idempotency] Side effect failed:', err);
```

---

### Step 3: Replace `console.warn` with `logger.warn`

**Before:**
```typescript
console.warn('[rateLimit] Provider throttled:', providerId);
```

**After:**
```typescript
import { logger } from './logger';

logger.warn('[rateLimit] Provider throttled:', providerId);
```

---

### Step 4 (Optional): Wrap Global `console`

If you want to ensure that ALL `console.log` calls (including third-party libraries) are redacted, wrap the global `console` object:

```typescript
import { wrapConsole } from './logger';

// Enable global redaction (at application startup)
wrapConsole();

// Now all console.log calls are automatically redacted
console.log('Secret:', 'S...'); // Automatically redacted
```

**WARNING:** This is a global monkey-patch. Use with caution.

---

## Testing

### Run Tests

```bash
npm test -- redact.test.ts
npm run test:ci -- redact.test.ts
```

### Coverage

All redaction code paths are covered by tests (95%+ line coverage).

**Test Cases:**
- ✅ Stellar secret seeds (S...) are redacted
- ✅ Stellar public keys (G...) are preserved
- ✅ Bearer tokens are redacted
- ✅ HMAC secrets are redacted
- ✅ Deep nested objects are handled
- ✅ Error objects and stack traces are sanitized
- ✅ Circular references are handled
- ✅ Max depth is enforced

---

## Security Checklist

- ✅ Stellar secret seeds (S...) are redacted
- ✅ Stellar public keys (G...) are preserved
- ✅ Webhook HMAC secrets are redacted
- ✅ Bearer tokens are redacted
- ✅ Generic secrets (password, api_key, etc.) are redacted
- ✅ Deep nested objects are traversed
- ✅ Error messages are sanitized
- ✅ Stack traces are sanitized
- ✅ Circular references are handled
- ✅ Max depth is enforced
- ✅ No real secrets in test files

---

## Troubleshooting

### Secrets Still Appearing in Logs

**Symptom:** Secrets are not being redacted.

**Possible Causes:**
1. Using `console.log` instead of `logger.log`.
2. Secret pattern not recognized (e.g., custom key name).
3. Secret is in a non-enumerable property (e.g., Symbol key).

**Solutions:**
1. Replace all `console.log` with `logger.log`.
2. Register custom sensitive keys: `registerSensitiveKey('my_custom_secret')`.
3. Use `wrapConsole()` to wrap the global `console` object.

---

### Performance Degradation

**Symptom:** Logging is slow.

**Possible Causes:**
1. Very deeply nested objects (20+ levels).
2. Very large objects (1000+ properties).
3. Circular references causing repeated traversal.

**Solutions:**
1. Reduce object nesting depth.
2. Log only relevant properties (not entire objects).
3. Use `logger.debug` for verbose logs (can be disabled in production).

---

### Public Keys Being Redacted

**Symptom:** Stellar public keys (G...) are being redacted.

**Possible Causes:**
1. Public key is associated with a sensitive key name (e.g., `secret`).
2. Public key is in a string that also contains a secret seed.

**Solutions:**
1. Use a non-sensitive key name (e.g., `publicKey` instead of `secret`).
2. Log public keys separately from secret seeds.

---

## File Map

| File | Purpose |
|---|---|
| `src/redact.ts` | Core redaction utility (regex patterns, deep traversal) |
| `src/redact.test.ts` | Comprehensive test suite (95%+ coverage) |
| `src/logger.ts` | Centralized logger with automatic redaction |
| `docs/backend/logging-security.md` | This document |

---

## References

- [Stellar Secret Seeds](https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/accounts#secret-seed)
- [JWT/OAuth Bearer Tokens](https://datatracker.ietf.org/doc/html/rfc6750)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
