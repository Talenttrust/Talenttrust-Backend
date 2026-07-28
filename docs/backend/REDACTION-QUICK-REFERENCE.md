# Log Redaction Quick Reference

## Core Patterns

| Pattern | Example | Redacted Output |
|---------|---------|-----------------|
| **Stellar Secret Seed** | `SALAACGR7QWWI7WQMXLA...` | `[REDACTED_STELLAR_SECRET]` |
| **Stellar Public Key** | `GALAACGR7QWWI7WQMXLA...` | **NOT REDACTED** (preserved) |
| **Bearer Token** | `Bearer eyJhbGciOiJIUzI1NiI...` | `Bearer [REDACTED_TOKEN]` |
| **HMAC Secret** | `secret: "a".repeat(64)` | `secret: "[REDACTED]"` |
| **Long Secret** | `[A-Za-z0-9+/=]{40,}` | `[REDACTED_SECRET]` |

---

## Sensitive Keys (Always Redacted)

```
secret, signing_key, webhook_secret, hmac_secret, api_secret,
password, passwd, pwd, api_key, apikey, private_key,
authorization, token, access_token, refresh_token, bearer,
client_secret, consumer_secret, oauth_token, session_token
```

---

## Usage

### Replace `console.log` with `logger.log`

```typescript
import { logger } from './logger';

// Before (UNSAFE):
console.log('User secret:', stellarSecret);

// After (SAFE):
logger.log('User secret:', stellarSecret);
// Output: User secret: [REDACTED_STELLAR_SECRET]
```

### Replace `console.error` with `logger.error`

```typescript
import { logger } from './logger';

// Before (UNSAFE):
console.error('Error:', error);

// After (SAFE):
logger.error('Error:', error);
// Output: Error: { name: 'Error', message: '[REDACTED]', stack: '[REDACTED]' }
```

---

## Register Custom Sensitive Keys

```typescript
import { registerSensitiveKey } from './redact';

registerSensitiveKey('stripe_secret_key');
registerSensitiveKey('twilio_auth_token');

logger.log('Config', { stripe_secret_key: 'sk_live_...' });
// Output: Config { stripe_secret_key: '[REDACTED]' }
```

---

## Deep Traversal

### Nested Objects (5+ Levels)

```typescript
logger.log('User data', {
  user: {
    profile: {
      stellarAccount: {
        publicKey: 'G...',  // Preserved
        secretKey: 'S...',  // Redacted
      },
    },
  },
});
```

### Error Objects

```typescript
const error = new Error('Auth failed with secret: S...');
logger.error('Error occurred', error);
// Output: Error occurred {
//   name: 'Error',
//   message: 'Auth failed with secret: [REDACTED_STELLAR_SECRET]',
//   stack: '...' // Stack trace also redacted
// }
```

### Circular References

```typescript
const obj = { name: 'test' };
obj.self = obj; // Circular reference

logger.log('Circular object', obj);
// Output: Circular object { name: 'test', self: '[CIRCULAR_REFERENCE]' }
```

---

## Performance

| Operation | Complexity | Typical Time |
|-----------|------------|--------------|
| String redaction (1000 chars) | O(n) | ~0.1ms |
| Object redaction (10 props) | O(n × d) | ~0.01ms |
| Deep object (5 levels) | O(n × d) | ~0.1ms |
| Max depth (20 levels) | O(n × d) | ~1ms |

**Optimizations:**
- Skip regex for strings <10 chars
- Early exit for primitives (numbers, booleans, null)
- Circular reference detection (WeakSet)
- Max depth guard (20 levels)

---

## Testing

```bash
# Run redaction tests
npm test -- redact.test.ts

# Run with coverage
npm run test:ci -- redact.test.ts
```

**Coverage:** 95%+ line coverage

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

---

## Troubleshooting

### Secrets Still Appearing in Logs

**Solution:**
1. Replace `console.log` with `logger.log`
2. Register custom keys: `registerSensitiveKey('my_custom_secret')`
3. Use `wrapConsole()` to wrap global `console`

### Performance Degradation

**Solution:**
1. Reduce object nesting depth
2. Log only relevant properties (not entire objects)
3. Use `logger.debug` for verbose logs (can be disabled in production)

### Public Keys Being Redacted

**Solution:**
1. Use non-sensitive key names (e.g., `publicKey` instead of `secret`)
2. Log public keys separately from secret seeds

---

## File Locations

```
src/
├── redact.ts              # Core redaction utility
├── redact.test.ts         # Comprehensive test suite
└── logger.ts              # Centralized logger

docs/backend/
├── logging-security.md    # Full documentation
└── REDACTION-QUICK-REFERENCE.md  # This file
```

---

## Optional: Global Console Wrapper

```typescript
import { wrapConsole } from './logger';

// Enable at application startup
wrapConsole();

// Now ALL console.log calls are automatically redacted
console.log('Secret:', 'S...'); // Automatically redacted
```

**WARNING:** This is a global monkey-patch. Use with caution.
