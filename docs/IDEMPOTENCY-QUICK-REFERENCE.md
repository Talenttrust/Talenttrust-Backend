# Idempotency Quick Reference

## Overview

Contract creation endpoints enforce HTTP idempotency to safely retry requests without creating duplicate contracts. Clients provide an `Idempotency-Key` header, and the server stores the response for a configurable TTL (default: 1 hour).

## Endpoint Coverage

- **POST /api/v1/contracts** — contract creation with full idempotency support

## Usage

### Basic Request

```http
POST /api/v1/contracts HTTP/1.1
Authorization: Bearer <jwt-token>
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "title": "Software Development Contract",
  "description": "Full-stack web application development",
  "clientId": "client-uuid",
  "freelancerId": "freelancer-uuid",
  "budget": 10000
}
```

### Response Codes

| Status | Scenario | Description |
|--------|----------|-------------|
| 201    | Success (first) | Contract created successfully |
| 200    | Success (replay) | Cached response returned (with `Idempotency-Replayed: true` header) |
| 400    | Bad Request | Missing or empty `Idempotency-Key` header |
| 401    | Unauthorized | Authentication required (no `req.user` found) |
| 409    | Conflict | Same key reused with different request body |

## Security

### Authentication Required

**⚠️ Security Notice:** Idempotency middleware **fails closed** when authentication is missing.

- Unauthenticated requests are **rejected with 401** to prevent shared-scope collisions
- Even if the middleware is called without prior auth, it will return 401
- Defense-in-depth: prevents cross-caller collisions if auth middleware is bypassed

**Before (vulnerable):**
```typescript
// Two unauthenticated callers with same key → COLLISION
// Both mapped to shared 'unknown-user' scope ❌
```

**After (secure):**
```typescript
// Two unauthenticated callers with same key → BOTH GET 401 ✅
// No shared scope, fail-closed behavior
```

### Per-User Scoping

Idempotency keys are **scoped to the authenticated user** (`req.user.id`):

- User A with key `abc123` and User B with key `abc123` create **separate contracts**
- Each user can only replay their own cached responses
- Scoped key format: `sha256(userId:idempotencyKey)`

**Example:**
```javascript
// User 1 creates contract
POST /contracts
Authorization: Bearer <user1-token>
Idempotency-Key: abc123
→ 201 Created (contract-id-1)

// User 2 creates different contract with SAME key
POST /contracts
Authorization: Bearer <user2-token>
Idempotency-Key: abc123
→ 201 Created (contract-id-2)  // Different contract!

// User 1 replays
POST /contracts
Authorization: Bearer <user1-token>
Idempotency-Key: abc123
→ 200 OK (contract-id-1)  // Gets their own original response
Idempotency-Replayed: true
```

## Behavior

### First Request

- Validates `Idempotency-Key` header is present and non-empty
- Validates `req.user` is present (returns 401 if missing)
- Computes payload hash using stable JSON serialization
- Executes contract creation
- Stores `{ scopedKey, payloadHash, response }` in cache
- Returns 201 with contract data

### Replay (Same Key + Same Body)

- Retrieves cached entry by scoped key
- Verifies payload hash matches
- Returns cached response with status 200
- Sets `Idempotency-Replayed: true` header
- **Does NOT create a duplicate contract**

### Conflict (Same Key + Different Body)

- Retrieves cached entry by scoped key
- Detects payload hash mismatch
- Returns 409 Conflict
- Error message: "Idempotency-Key was reused with a different request body"
- **Does NOT create a contract**

## Payload Hashing

The middleware computes a **stable hash** of the request body:

- **Order-independent:** `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same hash
- **Deep comparison:** Nested objects and arrays are hashed recursively
- **Algorithm:** SHA-256 of stable JSON representation

**Example:**
```javascript
// These payloads are considered IDENTICAL:
{ title: "Contract", budget: 5000 }
{ budget: 5000, title: "Contract" }

// These payloads are DIFFERENT (→ 409):
{ title: "Contract", budget: 5000 }
{ title: "Contract", budget: 6000 }
```

## TTL and Expiration

- **Default TTL:** 1 hour (3600 seconds)
- Expired entries are treated as absent
- Configurable via `IdempotencyStoreConfig.ttlMs`
- Automatic purge on `store.get()` checks expiration

## Headers

### Request Headers

```http
Idempotency-Key: <unique-string>
```

- **Required:** Yes
- **Format:** Any non-empty string (UUID recommended)
- **Trimming:** Leading/trailing whitespace is automatically trimmed
- **Scope:** Per-user (multiple users can use the same key)

### Response Headers

```http
Idempotency-Replayed: true
```

- **Present:** Only on cached/replayed responses (status 200)
- **Absent:** On first request (status 201), errors (4xx), conflicts (409)

## Error Responses

### 400 Bad Request — Missing Idempotency-Key

```json
{
  "error": {
    "code": "bad_request",
    "message": "Idempotency-Key header is required",
    "requestId": "req-abc123"
  }
}
```

### 401 Unauthorized — No Authentication

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Authentication required for idempotent contract creation",
    "requestId": "req-def456"
  }
}
```

### 409 Conflict — Key Reused with Different Body

```json
{
  "error": {
    "code": "conflict",
    "message": "Idempotency-Key was reused with a different request body",
    "requestId": "req-ghi789"
  }
}
```

## Client Best Practices

1. **Generate unique keys per operation**
   ```javascript
   const idempotencyKey = crypto.randomUUID();
   ```

2. **Store keys for retry logic**
   ```javascript
   localStorage.setItem(`contract-create-key`, idempotencyKey);
   ```

3. **Retry with the SAME key on network failures**
   ```javascript
   try {
     await createContract(payload, idempotencyKey);
   } catch (networkError) {
     // Safe to retry with same key
     await createContract(payload, idempotencyKey);
   }
   ```

4. **Check `Idempotency-Replayed` header**
   ```javascript
   if (response.headers.get('Idempotency-Replayed') === 'true') {
     console.log('This is a replayed response, contract was not re-created');
   }
   ```

5. **Use different keys for different contracts**
   ```javascript
   // ❌ Wrong: Reusing same key for different contracts
   await createContract(contract1, 'my-key');
   await createContract(contract2, 'my-key');  // → 409 Conflict

   // ✅ Correct: New key per contract
   await createContract(contract1, crypto.randomUUID());
   await createContract(contract2, crypto.randomUUID());
   ```

## Testing

Run idempotency middleware tests:

```bash
npm test -- contractIdempotency.test
```

Coverage includes:
- ✅ Security: fail-closed on unauthenticated requests
- ✅ Header validation: missing/empty key
- ✅ First request: successful creation
- ✅ Replay: cached response with header
- ✅ Conflict: same key + different body
- ✅ Per-user scoping: independent results
- ✅ Regression: unauthenticated callers cannot collide

## Implementation Details

### Middleware Stack Order

```typescript
router.post('/',
  requireAuth,                          // 1. Authenticate user
  requirePermission('contracts', 'create'), // 2. Check permissions
  contractCreateIdempotencyMiddleware(),    // 3. Check idempotency
  validateSchema(createContractSchema),     // 4. Validate payload
  controller.createContract              // 5. Execute handler
);
```

### Scoped Key Generation

```typescript
// User ID is extracted from req.user.id (JWT decoded.sub)
const userScopeId = req.user.id;  // e.g., "user-abc123"
const idempotencyKey = req.headers['idempotency-key'];  // e.g., "key-xyz789"

// Scoped key = SHA-256("user-abc123:key-xyz789")
const scopedKey = sha256(`${userScopeId}:${idempotencyKey.trim()}`);
```

### Storage Schema

```typescript
interface IdempotencyRecord {
  key: string;           // Scoped key (sha256 hash)
  payloadHash: string;   // SHA-256 of stable JSON
  result: {
    statusCode: number;  // Original HTTP status (usually 201)
    body: unknown;       // Original response body
  };
  createdAt: Date;       // Record creation timestamp
  expiresAt: Date;       // TTL expiration timestamp
}
```

## Troubleshooting

### "Idempotency-Key was reused with a different request body"

**Cause:** You're sending a different payload with the same key.

**Solution:**
- Use a fresh key for each unique contract
- Or ensure the payload is byte-for-byte identical (including property order)

### "Authentication required for idempotent contract creation"

**Cause:** No `req.user` found (auth middleware didn't run or failed).

**Solution:**
- Ensure you're sending a valid `Authorization: Bearer <token>` header
- Check that the JWT is not expired
- Verify the token was signed with the correct secret

### Replay not working (getting 201 instead of 200)

**Possible causes:**
1. **Different user:** Keys are per-user scoped
2. **Expired cache:** TTL passed (default 1 hour)
3. **Server restart:** In-memory store is cleared
4. **Different payload order:** This should work; if not, file a bug

## Security Considerations

### Why Fail Closed?

Falling back to a shared `'unknown-user'` scope would allow:

1. **Attacker A** sends unauthenticated request with key `abc123`
2. **Attacker B** sends unauthenticated request with same key `abc123`
3. Without fail-closed: B sees A's cached response (information leak)
4. With fail-closed: Both get 401, no data leakage ✅

### Defense in Depth

Even though `requireAuth` runs before the idempotency middleware in the current route configuration, the middleware independently validates `req.user` to ensure:

- Resilience to middleware ordering changes
- Protection if called in contexts without auth
- Clear error messages for debugging
- No silent degradation to insecure behavior

## Related Documentation

- [Authentication & Authorization](./backend/authentication-authorization.md)
- [Error Handling](./backend/error-handling.md)
- [Request Validation Framework](./backend/request-validation-framework.md)
- [API Documentation](./API.md)

---

**Last Updated:** 2026-07-24  
**Version:** 1.0.0  
**Status:** Active (security hardening applied)
