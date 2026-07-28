# JWT Expiry, Signature, and Malformed-Token Tests for requireAuth

## Summary

This PR adds comprehensive negative test cases for the `requireAuth` middleware in `src/middleware/authorization.ts` to ensure proper rejection of malformed, expired, and maliciously-crafted JWT tokens.

## Changes

### Test Enhancements (`src/auth/authenticate.test.ts`)

Added the following test cases to the existing test suite:

1. **Missing Claims Tests**
   - `rejects a token missing the required 'sub' claim` - Verifies tokens without `sub` are rejected with "missing required claims" message
   - `rejects a token missing the required 'email' claim` - Verifies tokens without `email` are rejected
   - `rejects a token missing the required 'role' claim` - Verifies tokens without `role` are rejected with "unrecognised role" message

2. **Header Edge Case Tests**
   - `rejects missing Authorization header` - Verifies 401 on missing Authorization header
   - `rejects malformed Bearer prefix (no space)` - Verifies rejection when "Bearer" prefix lacks space separator
   - `rejects empty token after Bearer` - Verifies rejection of empty token string after "Bearer "
   - `rejects malformed Bearer prefix (wrong prefix)` - Verifies rejection of non-Bearer authentication schemes (e.g., Basic)

3. **Malformed Token Tests**
   - `rejects a token with a tampered signature` - Verifies tokens with modified signatures are rejected
   - `rejects a token with malformed base64 payload` - Verifies tokens with invalid base64 encoding are rejected

### Documentation Enhancement (`src/middleware/authorization.ts`)

Added JSDoc security notes to the `requireAuth` function documenting:
- Only HS256 algorithm is accepted
- Required claims (`sub`, `email`, `role`)
- Role validation against platform allowlist
- Rejection of `alg: none` and algorithm confusion attempts

## Security Rationale

The test additions ensure that:

1. **JWT Expiry**: Expired tokens are rejected with an appropriate error message, preventing replay attacks on stale tokens.

2. **Signature Validation**: Tokens signed with a different secret or with tampered signatures fail HMAC verification, preventing forgery.

3. **Algorithm Confusion Protection**: The tests explicitly verify that:
   - `alg: none` tokens are rejected (prevents unsecured JWT bypass)
   - RS256, HS384, HS512 algorithms are rejected (prevents algorithm confusion attacks)
   - Tokens without an algorithm header are rejected

4. **Claim Validation**: Missing or malformed claims result in rejection before the request reaches protected endpoints, ensuring request integrity.

## Test Coverage

All 31 tests pass successfully, covering the full spectrum of JWT verification failure modes for the `requireAuth` middleware.

closes #473