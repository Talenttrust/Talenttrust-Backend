# Bulk Disputes Endpoint Design (Issue #812)

## Analysis & Decision Rationale

### 1. Current State
- Disputes routes exist but are **stubbed** (mock responses only, no real service)
- Available operations: create, read (list/get), update, delete
- Role-based access: Only admins can update/delete; clients/freelancers can only create/read

### 2. Financial Implications
- **Escrow State Machine**: Disputes trigger state transitions in linked contracts (active → disputed)
- **Notification Chain**: State transitions dispatch multi-channel notifications (email, web)
- **Per-Item Transactionality**: Each dispute operation must be isolated — one item's success must not depend on another's state, and a rollback must not partially apply side effects

### 3. Chosen Operation: `PATCH /api/v1/disputes/batch` (Bulk Update)
**Rationale**: 
- **Real-world use case**: Admins bulk-resolving multiple disputes is a plausible workflow (e.g., after investigation/review)
- **Financial stakes**: Resolving disputes affects escrow release, making this higher-risk than bulk-create
- **Precedent**: The single-item PATCH endpoint already supports updating dispute status
- **Scope**: Mirrors contracts pattern (update-many, not create-many)

### 4. Batch Cap Justification
- **Cap**: 50 items per batch
- **Justification**: 
  - Each item may trigger escrow state transitions and multi-channel notifications
  - 50 items = worst-case 100 notifications (email + web per item)
  - Prevents overwhelming notification/escrow subsystems
  - Rate limit allows ~5 requests/sec; cap prevents single request from consuming entire quota
  - Lower than typical CRUD batch (100–200) due to financial/notification side effects

### 5. Processing Model
- **Independent validation**: Each item validated against its current dispute state before processing
- **Isolated transactions**: Each item's update (and cascading notifications) happens within its own database transaction
- **No cross-item rollback**: One item's failure does not roll back prior items' writes
- **Per-item errors**: Failed items reported individually without aborting the batch

### 6. State Transition Validation
Disputes support the following state transitions:
- `open` → `under_review` (escalate/review)
- `open` → `resolved` (resolve/close)
- `under_review` → `resolved` (resolve after review)
- `open` → `escalated` (escalate to higher authority)

Invalid transitions (e.g., `resolved` → `resolved`) fail per-item with a clear error.

### 7. Authorization Model
- Each item checked against caller's permissions (admin-only for updates)
- Unauthorized items fail per-item; authorized items proceed
- No bypass of per-item auth by bundling

## Implementation

### Request Schema
```typescript
POST /api/v1/disputes/batch
{
  operations: [
    {
      id: string,              // dispute ID
      status: 'resolved' | ..., // new status
      resolution?: string,     // optional resolution note
    }
  ]
}
```

### Response Schema
```typescript
{
  results: [
    {
      index: number,
      success: true,
      dispute: { ... }
    },
    {
      index: number,
      success: false,
      error: {
        code: string,
        message: string
      }
    }
  ],
  summary: {
    total: number,
    succeeded: number,
    failed: number
  }
}
```

### Error Handling
- **Over-cap**: 400 + "Batch exceeds cap (max 50)"
- **Empty batch**: 400 + "Batch is empty"
- **Invalid transition**: Per-item 400 + "Invalid state transition from {current} to {requested}"
- **Unauthorized**: Per-item 403 + "Not authorized to update dispute"
- **Not found**: Per-item 404 + "Dispute not found"

### Transactionality
- Each item: separate database transaction
- Each item: cascading notifications (not transactional with dispute update, but failures logged)
- No partial side effects: If dispute update succeeds, notifications are fired; if update fails, no notifications

## Tests Required
1. **Empty batch**: Rejected with 400
2. **Over-cap batch**: Rejected with 400 if > 50 items
3. **Partial success**: Mixed valid/invalid items return per-item results
4. **Invalid state transition**: Item fails with per-item error while others proceed
5. **Authorization**: Unauthorized item fails; authorized items succeed
6. **Side effects**: Successful item triggers notifications; failed item does not
7. **Idempotency**: Same request twice (same dispute ID, same new status) returns same result
8. **All success**: All items pass → 200 with all successes
9. **All failure**: All items fail → 200 with all failures
10. **Boundary**: Exactly 50 items succeeds; 51 items rejected

