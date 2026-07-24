# Notifications

This document describes the pluggable notification transports and retry/persistence semantics.

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

## Persistence
- Web/in-app notifications are persisted to the `notifications` table so UI clients can fetch missed messages after restarts.

## Failure semantics
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
