# Fix: Enforce idempotent and unique credential issuance for achievements

Closes #123 (or whatever issue number this resolves)

## Approach
This PR implements a robust mechanism to issue credentials for achievements, ensuring uniqueness and idempotency. This prevents retries or duplicate chain events from issuing multiple credentials for the same achievement to a user.

- **Stable Achievement Identity:** We combine `tenantId`, `userId`, and `achievementId` to form a stable identity for uniqueness checks.
- **Atomic Uniqueness:** The solution uses an in-memory Map to guarantee that credential issuances are evaluated synchronously and atomically, averting race conditions.
- **Idempotent Replay:** If the exact same `eventId` is processed again, we return the existing credential instead of throwing an error.
- **Handling Edge Cases:**
  - Same user + different achievement -> creates a new credential.
  - Revoked prior credential -> throws a `ForbiddenError` if another event tries to reissue it.
  - Concurrent issuance -> gracefully fails subsequent identical attempts with `ConflictError`.

## Test Evidence
Focused unit tests have been added to `src/services/achievements.service.test.ts`. They cover:
1. First issuance (success path)
2. Duplicate event (idempotent replay)
3. Same user but different achievement (valid new issuance)
4. Concurrent issuance (Promise.all race conditions)
5. Revoked prior credential (authorization/boundary check)

All tests pass and the code strictly follows the repository's existing service and error conventions (`AppError`, `ConflictError`, `ForbiddenError`).

## Security Notes
- Prevents unbounded credential accumulation for a single achievement (denial of service/spam mitigation).
- Follows tenant isolation implicitly by scoping uniqueness to `tenantId`.
- No sensitive keys or private information are leaked in the credential payload or error messages.
