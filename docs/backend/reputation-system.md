# Reputation System

Production-grade reputation management system with SQLite persistence, comprehensive validation, anti-abuse protections, and mandatory audit logging.

## Data Model

### Database Schema

```sql
CREATE TABLE reputation_entries (
  id          TEXT    PRIMARY KEY,
  reviewer_id TEXT    NOT NULL REFERENCES users(id),
  target_id   TEXT    NOT NULL REFERENCES users(id),
  rating      INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment     TEXT    CHECK (length(comment) <= 1000),
  context_id  TEXT    NOT NULL REFERENCES contracts(id),
  created_at  TEXT    NOT NULL,
  UNIQUE(reviewer_id, target_id, context_id)
);
```

### Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | TEXT (UUID) | PRIMARY KEY | Unique identifier for the reputation entry |
| `reviewer_id` | TEXT (UUID) | NOT NULL, FK → users(id) | User submitting the rating |
| `target_id` | TEXT (UUID) | NOT NULL, FK → users(id) | User being rated |
| `rating` | INTEGER | NOT NULL, CHECK (1-5) | Rating value (1-5 scale) |
| `comment` | TEXT | CHECK (≤1000 chars) | Optional review comment |
| `context_id` | TEXT (UUID) | NOT NULL, FK → contracts(id) | Contract/trade reference |
| `created_at` | TEXT (ISO 8601) | NOT NULL | Timestamp of creation |

### Design Principles

- **Immutable records**: No UPDATE operations allowed; entries are append-only
- **DB-level uniqueness**: `UNIQUE(reviewer_id, target_id, context_id)` prevents duplicate ratings
- **Referential integrity**: Foreign keys ensure valid users and contracts
- **Indexed for performance**: Indexes on `target_id` and `context_id` for fast queries

---

## Validation Rules

### Rating Validation

- Must be an integer
- Must be within bounds: `1 ≤ rating ≤ 5`
- Enforced at both application and database levels

### Comment Validation

- **Maximum length**: 1000 characters
- **Cannot be empty**: Rejects null, empty string, or whitespace-only
- **Spam detection**: Rejects comments where any single character comprises >50% of the text
  - Example rejected: `"aaaaaaaaab"` (90% 'a')
  - Example accepted: `"abcde"` (20% each character)

### Payload Validation

- `reviewerId`: Required, non-empty string
- `targetId`: Required, valid UUID (from URL parameter)
- `contextId`: Required, valid UUID
- `rating`: Required, integer 1-5
- `comment`: Optional, string (if provided, must pass validation)

### Validation Layers

1. **Zod schema** (DTO layer): Input validation before reaching service
2. **Service layer**: Defense-in-depth validation (comment spam, business rules)
3. **Database constraints**: Final enforcement (CHECK constraints, UNIQUE)

---

## Anti-Abuse Protections

### 1. Self-Rating Prevention

**Rule**: Users cannot rate themselves.

```typescript
if (reviewerId === targetId) {
  throw new ForbiddenError('Users cannot rate themselves');
}
```

**HTTP Response**: `403 Forbidden`

### 2. Duplicate Rating Prevention

**Rule**: One rating per reviewer → target → context combination.

**Implementation**:
- Application-level check before insertion
- Database-level `UNIQUE` constraint as final safeguard

```typescript
const existing = repository.findByReviewerTargetContext(reviewerId, targetId, contextId);
if (existing) {
  throw new ConflictError('Rating already exists');
}
```

**HTTP Response**: `409 Conflict`

### 3. Authorization (Contract Participation)

**Rule**: Only participants of a contract can rate each other.

**Validation**:
```typescript
const reviewerParticipates = repository.verifyContractParticipation(contextId, reviewerId);
const targetParticipates = repository.verifyContractParticipation(contextId, targetId);

if (!reviewerParticipates || !targetParticipates) {
  throw new ForbiddenError('Only contract participants can submit ratings');
}
```

**HTTP Response**: `403 Forbidden`

### 4. Authentication Enforcement

**Rule**: Only authenticated users can submit ratings.

**Implementation**:
- `authenticateMiddleware` validates bearer token
- Controller verifies `reviewerId === authenticatedUserId`
- Prevents rating on behalf of other users

**HTTP Response**: `401 Unauthorized` (if not authenticated)

### 5. Spam and Flooding Protection

**Comment spam filter**:
- Detects excessive character repetition (>50% same character)
- Rejects empty/whitespace-only comments
- Enforced at DTO (Zod) and service layers

**Future enhancements** (not implemented):
- Rate limiting on rating submissions
- Time-based cooldown between ratings

---

## Audit Logging

### Mandatory Audit Trail

Every successful rating creation **must** emit an audit record. No writes occur without audit logging.

### Audit Entry Fields

```typescript
auditService.log({
  action: 'REPUTATION_UPDATED',
  severity: 'INFO',
  actor: reviewerId,
  resource: 'reputation',
  resourceId: targetId,
  metadata: {
    rating,
    comment: comment ? hashComment(comment) : undefined, // SHA-256 hash
    contextId,
  },
});
```

| Field | Value | Description |
|-------|-------|-------------|
| `action` | `'REPUTATION_UPDATED'` | Standardized audit action |
| `severity` | `'INFO'` | Event severity level |
| `actor` | `reviewerId` | User who submitted the rating |
| `resource` | `'reputation'` | Resource type |
| `resourceId` | `targetId` | User being rated |
| `metadata.rating` | number | Rating value |
| `metadata.comment` | string (SHA-256) | Hashed comment (not plaintext) |
| `metadata.contextId` | UUID | Contract reference |

### Immutability Guarantees

- Audit entries use hash-chain architecture (SHA-256 linking)
- Each entry includes `previousHash` for tamper detection
- Integrity verification available via `auditService.verifyIntegrity()`

### Sensitive Data Handling

- Comments are **hashed** (SHA-256) before storing in audit logs
- Prevents PII exposure in audit trail
- Original comment persists only in `reputation_entries` table

---

## API Behavior

### Endpoints

#### GET `/api/v1/reputation/:id`

Retrieve a freelancer's reputation profile.

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "freelancerId": "uuid",
    "score": 4.5,
    "totalRatings": 10,
    "jobsCompleted": 0,
    "reviews": [
      {
        "reviewerId": "uuid",
        "rating": 5,
        "comment": "Excellent work!",
        "createdAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "lastUpdated": "2024-01-01T00:00:00.000Z"
  }
}
```

#### POST `/api/v1/reputation/:id/rate`

Create a new reputation rating. Requires authentication.

**Request**:
```json
{
  "reviewerId": "uuid",
  "contextId": "uuid",
  "rating": 5,
  "comment": "Excellent freelancer!"
}
```

**Response** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "uuid",
    "reviewerId": "uuid",
    "targetId": "uuid",
    "rating": 5,
    "comment": "Excellent freelancer!",
    "contextId": "uuid",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### Error Responses

| Status Code | Error Type | Description |
|-------------|------------|-------------|
| 400 | Bad Request | Invalid payload (Zod validation failure) |
| 401 | Unauthorized | Missing or invalid authentication token |
| 403 | Forbidden | Self-rating, unauthorized user, or insufficient permissions |
| 409 | Conflict | Duplicate rating (same reviewer + target + context) |
| 422 | Unprocessable Entity | Business rule violation (comment spam, invalid rating) |
| 500 | Internal Server Error | Unexpected server error |

---

## Security Considerations

### SQL Injection Prevention

- All queries use **prepared statements** with parameter binding
- No string interpolation in SQL queries
- Example:
  ```typescript
  db.prepare('SELECT * FROM reputation_entries WHERE id = ?').get(id);
  ```

### Input Sanitization

- Zod schemas validate and sanitize all inputs
- XSS protection via Helmet middleware (applied globally)
- Comment length limits prevent buffer overflow attacks

### Authorization

- RBAC enforcement via `requirePermission` middleware
- Clients and freelancers can rate after contract participation
- Admins have full access to reputation data
- Guests have read-only access

### Audit Trail Integrity

- Hash-chain architecture prevents tampering
- Comments hashed in audit logs (SHA-256)
- Integrity verification available for compliance audits

### Data Privacy

- Comments not stored in plaintext in audit logs
- Foreign key constraints prevent orphaned records
- No PII exposed in error messages

---

## Testing

### Coverage Areas

- **Repository layer**: CRUD operations, constraints, contract verification
- **Service layer**: Anti-abuse checks, validation, audit logging, aggregation
- **Controller layer**: Error handling, authentication, response mapping
- **Integration tests**: Full API request/response cycle

### Test Commands

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:ci
```

### Key Test Scenarios

✅ Valid rating creation and persistence  
✅ Audit log creation on successful writes  
✅ Boundary ratings (1 and 5)  
✅ Self-rating prevention (403)  
✅ Duplicate rating prevention (409)  
✅ Unauthorized user prevention (403)  
✅ Comment validation (empty, spam, too long)  
✅ Audit entry correctness  
✅ Profile aggregation accuracy  

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────┐
│                    Client Request                        │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Authentication Middleware                   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│               RBAC Authorization                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│            Zod Schema Validation                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│          ReputationController                            │
│  - Extract request data                                  │
│  - Verify authenticated user === reviewer                │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│           ReputationService                              │
│  - Self-rating check                                     │
│  - Duplicate check                                       │
│  - Contract participation verification                   │
│  - Comment validation                                    │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌──────────────────┐      ┌──────────────────┐
│ReputationRepo    │      │   AuditService   │
│  - SQLite write  │      │  - Immutable log │
│  - FK checks     │      │  - Hash comment  │
│  - Unique check  │      │  - Hash chain    │
└──────────────────┘      └──────────────────┘
```

### Dependencies

- **better-sqlite3**: SQLite database driver
- **Zod**: Schema validation
- **Express**: HTTP framework
- **Audit system**: Immutable hash-chain logging

---

## Future Enhancements

- [ ] Rate limiting on rating submissions
- [ ] Time-based cooldown between ratings
- [ ] Reputation score decay over time
- [ ] Dispute mechanism for fraudulent ratings
- [ ] Anonymous ratings option
- [ ] Rich text comments with moderation
- [ ] Reputation badges/achievements
