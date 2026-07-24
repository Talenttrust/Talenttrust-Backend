# Notifications

This document describes the pluggable notification transports, repository persistence, database typing, and retry/persistence semantics.

## Transports
- `NotificationTransport` is the pluggable interface implemented by providers.
- `ConsoleTransport` is the default local/dev fallback (default).
- `WebhookTransport` uses `WebhookService` to sign and retry deliveries to external HTTP endpoints.
- `SMTPTransport` sends emails through the configured SMTP server.
- `SESTransport` sends emails through the AWS SES API.
- `SendGridTransport` sends emails through the SendGrid v3 API.

## Configuration
Use environment variables to configure email transports:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_PROVIDER` | Email provider to use (`console`, `smtp`, `ses`, `sendgrid`) | `console` |
| `SMTP_HOST` | SMTP server hostname | - |
| `SMTP_PORT` | SMTP server port | - |
| `SMTP_USER` | SMTP username (optional) | - |
| `SMTP_PASSWORD` | SMTP password (optional) | - |
| `SMTP_FROM` | From email address | - |
| `SMTP_SECURE` | Use TLS (true/false) | - |
| `AWS_ACCESS_KEY_ID` | AWS access key for SES (optional) | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key for SES (optional) | - |
| `AWS_REGION` | AWS region for SES (optional) | - |
| `SENDGRID_API_KEY` | SendGrid API key (optional) | - |

## Persistence & Repository

Web/in-app notifications are persisted to the `notifications` SQLite database table using `NotificationRepository` (`src/repositories/notificationRepository.ts`). This allows frontend UI clients to fetch past notifications after page reloads or service restarts.

### Database Schema (Migration 12)

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
```

### NotificationRepository API & Database Typing

`NotificationRepository` connects to SQLite using the native `BetterSqlite3.Database` handle type:

```typescript
import type BetterSqlite3 from 'better-sqlite3';

export class NotificationRepository {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  saveWebNotification(userId: string, title: string, message: string): string;
  findByUser(userId: string): WebNotification[];
}
```

- **`saveWebNotification(userId, title, message)`**: Generates a random UUID primary key and persists the notification with an ISO 8601 timestamp (`created_at`). Returns the notification UUID string.
- **`findByUser(userId)`**: Queries all notification records for the specified `userId`, ordered by `created_at DESC` (newest first). Returns an array of `WebNotification` objects (`{ id, title, message, createdAt }`).

### Unit Testing & In-Memory Isolation

The repository is tested in `src/repositories/notificationRepository.test.ts` against an isolated in-memory SQLite instance (`getDb(':memory:')`).

To run the repository tests:

```bash
npx jest src/repositories/notificationRepository.test.ts
```

## Failure Semantics
- Transport methods return a `NotificationResult` with `success: boolean` and optional `message`.
- A provider exception produces `{ success: false, message }`, allowing the caller or
  queue to retry; it is never reported as a successful delivery.
- Selecting a real provider without its required configuration fails at transport
  construction. Only `EMAIL_PROVIDER=console` selects the console transport.
- WebhookTransport reuses `WebhookService` which implements bounded retry and DLQ fallback.

## Security
- Email `to` addresses are validated as one RFC-shaped recipient; malformed,
  multi-recipient, and header-injection (CR/LF) values are rejected before dispatch.
- Web notifications validate `userId` for basic sanity; authorization (session matching) should be enforced by callers to prevent IDOR.
- Email addresses are redacted in logs to avoid leaking PII.
- Secrets and API keys are redacted in logs.

## Escrow Lifecycle Hook Dispatch
The backend includes centralized dispatch hooks (`EscrowHooks`) that fan out escrow lifecycle events concurrently to all configured notification channels (e.g. Email and Web notification channels).

### Lifecycle State Transitions
The `EscrowHooks.onStateTransition` hook maps contract status changes to specific `KeyEscrowEvent` types:

| Transition Type | Old Status | New Status | Event Triggered |
|---|---|---|---|
| **Funded** | `draft` | `active` | `KeyEscrowEvent.FUNDS_DEPOSITED` |
| **Released** | `active` | `completed` | `KeyEscrowEvent.ESCROW_RESOLVED` |
| **Disputed** | `active` | `disputed` | `KeyEscrowEvent.DISPUTE_RAISED` |

Any other state transitions or unchanged statuses (e.g. `active` -> `active`) are ignored and do not trigger any notifications.

### Payload Shape
The event payload must conform to the `EscrowEventPayload` interface:
```typescript
interface EscrowEventPayload {
  contractId: string; // The contract UUID
  userEmail: string;  // PII-sensitive email of the recipient (redacted in logs)
  userId: string;     // Recipient platform identifier
  amount?: string;    // Optional contract budget/milestone amount
  reason?: string;    // Optional reason context (e.g. for disputes)
}
```
All dispatches are performed offline and deterministically in the test suite using injected fakes/mocks.
