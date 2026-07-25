# Outbound Email Notifications

This guide covers both synchronous notification dispatch and the asynchronous
queue-based email processor.

## Queue email processor

Queued `email-notification` jobs are handled by
[`src/queue/processors/email-processor.ts`](../src/queue/processors/email-processor.ts)
using the pluggable transport in
[`src/queue/processors/email.transport.ts`](../src/queue/processors/email.transport.ts).

### Flow

1. Validate the recipient with a strict single-address check (CR/LF, multi-recipient
   separators, and non-RFC shapes are rejected).
2. Require non-empty `subject` and `body`.
3. Guard `to` / `subject` / `body` against SMTP header injection.
4. Dispatch through the configured {@link EmailTransport}; provider failures throw
   so BullMQ retries the job instead of marking it successful.
5. Return `{ success, message, data: { emailId } }` on success.

### Transport selection

`resolveEmailTransport()` reads validated config from `src/config/env.schema.ts`:

| `EMAIL_PROVIDER` | Transport class           | Required config                               |
| ---------------- | ------------------------- | --------------------------------------------- |
| `console`        | `ConsoleEmailTransport`   | — (default in development/test)               |
| `smtp`           | `SmtpEmailTransport`      | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`         |
| `ses`            | `SesEmailTransport`       | `SMTP_FROM`, `AWS_REGION`, AWS credentials    |
| `sendgrid`       | `SendGridEmailTransport`  | `SMTP_FROM`, `SENDGRID_API_KEY`               |

Set `EMAIL_SEND_TIMEOUT_MS` (default `10000`) to bound provider calls.

Tests inject a mock via `setEmailTransportOverride()`; production code must not
log full recipient addresses or bodies at info level.

---

## Notification service subsystem

The following section documents the outbound notification subsystem so contributors can
extend it safely. It reflects the code as implemented in:

- Orchestration: [`src/services/notification.service.ts`](../src/services/notification.service.ts)
- Transports: [`src/services/notification.transport.ts`](../src/services/notification.transport.ts)
- Persistence: [`src/repositories/notificationRepository.ts`](../src/repositories/notificationRepository.ts)
- Types: [`src/types/notification.types.ts`](../src/types/notification.types.ts)

## Channels

The subsystem dispatches two channels, both orchestrated by
`NotificationService`:

| Channel | Method                              | Payload type   | Persisted? |
| ------- | ----------------------------------- | -------------- | ---------- |
| Email   | `sendEmail(to, event, data?)`       | `EmailPayload` | No         |
| Web     | `sendWebNotification(userId, …)`    | `WebPayload`   | Yes        |

Both methods are driven by a `KeyEscrowEvent` (see
`src/types/notification.types.ts`): `ESCROW_INITIALIZED`, `FUNDS_DEPOSITED`,
`MILESTONE_APPROVED`, `DISPUTE_RAISED`, `ESCROW_RESOLVED`, `ESCROW_CANCELLED`.

### `NotificationResult` contract

Every dispatch returns a structured `NotificationResult` (defined in
`notification.transport.ts`) rather than a bare boolean, so callers can react to
partial failures:

```ts
interface NotificationResult {
  success: boolean;
  message?: string; // present on failure
}
```

`NotificationService` never throws to the caller: input/transport errors are
caught and surfaced as `{ success: false, message }`.

### Recipient validation

- **Email:** `to` is validated by `isValidEmail` before dispatch. The address
  must be non-empty, free of CR/LF (header-injection) characters, and match a
  basic RFC-shaped pattern. An invalid address short-circuits with
  `{ success: false, message: 'Invalid email address' }` and is never handed to
  a transport.
- **Web:** `userId` must be non-empty and free of CR/LF; otherwise the call
  returns `{ success: false, message: 'Invalid user ID' }`.

When logging recipients, the service redacts the local part of the email
(`ab***@domain`) and only logs the user ID for web notifications.

## Transports

Transports implement the pluggable `NotificationTransport` interface, which may
provide `sendEmail` and/or `sendWebNotification`:

```ts
interface NotificationTransport {
  sendEmail?: (payload: EmailPayload) => Promise<NotificationResult>;
  sendWebNotification?: (payload: WebPayload) => Promise<NotificationResult>;
}
```

Available implementations: `ConsoleTransport` (default fallback used in tests and
local dev), `SMTPTransport`, `SESTransport`, `SendGridTransport`, and
`WebhookTransport`. The SMTP/SES/SendGrid transports are placeholder
implementations (no third-party SDK is wired in yet) but already reject payloads
containing CR/LF in `to`/`subject`/`body` as a header-injection guard.

### Email transport selection

`NotificationService.createEmailTransport()` selects the email transport from
configuration at construction time:

| `EMAIL_PROVIDER` | Required config                          | Transport            | Fallback on missing config |
| ---------------- | ---------------------------------------- | -------------------- | -------------------------- |
| `smtp`           | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`    | `SMTPTransport`      | `ConsoleTransport`         |
| `ses`            | `SMTP_FROM`                              | `SESTransport`       | `ConsoleTransport`         |
| `sendgrid`       | `SMTP_FROM`                              | `SendGridTransport`  | `ConsoleTransport`         |
| _unset / other_  | —                                        | `ConsoleTransport`   | —                          |

If required config is incomplete, the service logs a warning and falls back to
`ConsoleTransport` rather than failing to construct. The web transport defaults
to `ConsoleTransport` unless one is injected via the constructor `options`.

## Web-notification persistence

Web notifications are persisted through `NotificationRepository` so the UI can
read notifications that were missed across restarts. The repository is backed by
SQLite (`better-sqlite3`) and uses prepared statements (no string
interpolation).

### `notifications` table

The repository reads and writes a `notifications` table with the following
columns (as used by the repository SQL):

| Column       | Type   | Notes                                  |
| ------------ | ------ | -------------------------------------- |
| `id`         | TEXT   | UUID, generated per notification       |
| `user_id`    | TEXT   | Target user                            |
| `title`      | TEXT   | Notification title                     |
| `message`    | TEXT   | Notification body                      |
| `created_at` | TEXT   | ISO-8601 timestamp                     |

### Methods

- `saveWebNotification(userId, title, message): string` — inserts a row with a
  freshly generated UUID and ISO timestamp, returning the new `id`.
- `findByUser(userId): Array<{ id, title, message, createdAt }>` — returns the
  user's notifications ordered by `created_at` descending.

### Failure semantics

`sendWebNotification` persists via `saveWebNotification` before invoking the web
transport. A persistence error is caught and logged; the dispatch result is then
determined by the transport (or the no-transport fallback). When extending this
path, ensure a persistence failure is reported as failure rather than masked as
success.

## Environment variables

The email transport is configured entirely from environment variables. Secrets
are handled by the structured logger's redaction (`src/utils/redact.ts`,
`redactSecret`) and must never be logged in raw form.

| Variable                | Purpose                                   | Secret |
| ----------------------- | ----------------------------------------- | ------ |
| `EMAIL_PROVIDER`        | `smtp` \| `ses` \| `sendgrid`             | No     |
| `SMTP_HOST`             | SMTP server host                          | No     |
| `SMTP_PORT`             | SMTP server port                          | No     |
| `SMTP_USER`             | SMTP auth user                            | No     |
| `SMTP_PASSWORD`         | SMTP auth password                        | Yes    |
| `SMTP_FROM`             | From address (required for all providers) | No     |
| `SMTP_SECURE`           | Use TLS (`true`/`false`)                  | No     |
| `AWS_ACCESS_KEY_ID`     | AWS SES access key                        | Yes    |
| `AWS_SECRET_ACCESS_KEY` | AWS SES secret key                        | Yes    |
| `AWS_REGION`            | AWS SES region                            | No     |
| `SENDGRID_API_KEY`      | SendGrid API key                          | Yes    |
| `DB_PATH`               | SQLite path for persistence (`:memory:` in tests) | No |

### `.env`-aligned snippet (no real values)

```dotenv
# Email channel
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASSWORD=__set_me__        # secret — redacted in logs
SMTP_FROM=notifications@example.com
SMTP_SECURE=true

# SES (when EMAIL_PROVIDER=ses)
AWS_ACCESS_KEY_ID=__set_me__    # secret
AWS_SECRET_ACCESS_KEY=__set_me__ # secret
AWS_REGION=us-east-1

# SendGrid (when EMAIL_PROVIDER=sendgrid)
SENDGRID_API_KEY=__set_me__     # secret

# Web-notification persistence
DB_PATH=talenttrust.db
```
