# Implementation Plan for Issue #1348

## Current State Analysis

The `src/audit/redact.ts` module already has basic safety features from #1347:
- ✅ Circular reference protection (WeakSet-based)
- ✅ Depth limiting (MAX_REDACTION_DEPTH = 100)
- ✅ Basic safe failure mode (try-catch in redactHeaders)
- ✅ Input validation (coercion in buildAuditMetadata)

## What's Missing for Deterministic Failure Recovery (#1348)

**Current Gaps:**
1. **Non-deterministic recovery**: Try-catch in `redactHeaders` returns partial results on error
2. **No structured error reporting**: Errors are logged but not returned to callers
3. **No failure classification**: Can't distinguish transient vs permanent failures
4. **No observability**: No metrics for failure rates or types
5. **Partial completion risk**: If processing fails mid-way, inconsistent state may be returned
6. **No retry mechanisms**: Transient failures cannot be retried

## Proposed Implementation Plan

### Affected Modules
- `src/audit/redact.ts` (primary changes)
- `src/audit/audit.test.ts` (add failure recovery tests)

### State/Invariant Changes
1. **Add error result types**: `RedactionResult<T>` for success/failure with structured error info
2. **Implement deterministic recovery**: Each function has a well-defined recovery strategy
3. **Add failure classification**: Distinguish between transient (retryable) and permanent failures
4. **Add metrics hook**: Optional metrics callback for observability
5. **Ensure atomicity**: Either complete successfully or return a deterministic fallback

### Test Strategy
1. **Recovery tests**: Verify each failure mode has deterministic recovery
2. **Partial failure tests**: Ensure mid-way failures don't produce inconsistent state
3. **Error classification tests**: Verify correct classification of failure types
4. **Metrics tests**: Verify metrics are emitted correctly
5. **Determinism tests**: Same failure always produces same recovery result

### Compatibility Considerations
- Add new optional parameter for metrics callback (backward compatible)
- Existing API can remain unchanged with internal error handling
- Or add new `*Safe` variants that return `RedactionResult` (non-breaking)

### Estimate
- Implementation: 3-4 hours
- Tests: 2-3 hours
- Total: 5-7 hours

## Next Steps
1. Create initial commit with this plan
2. Push and create PR
3. Implement the changes
4. Update PR with final implementation
