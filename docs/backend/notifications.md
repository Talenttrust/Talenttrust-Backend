# Notification Service & Escrow Hooks

## Overview

The Notification Service Hooks module provides a centralized way to broadcast
multi-channel alerts across the TalentTrust decentralized freelancer escrow
protocol. When key events happen in the escrow lifecycle (e.g., Funds
Deposited, Dispute Raised), hooks are triggered to execute concurrent external
delivery mechanics.

Currently supported communication channels:

1. **Email Notifications** — synchronous/queued template dispatch
2. **Web Push / In-App Notifications** — persistent or ephemeral UI notifications

---

## Supported Key Escrow Events

Defined in `src/types/notification.types.ts`:

| Event                  | Description                               |
| ---------------------- | ----------------------------------------- |
| `ESCROW_INITIALIZED`   | A new escrow contract has been created.   |
| `FUNDS_DEPOSITED`      | Funds were deposited into escrow.         |
| `MILESTONE_APPROVED`   | A milestone was approved for release.     |
| `DISPUTE_RAISED`       | A dispute was opened on the contract.     |
| `ESCROW_RESOLVED`      | The escrow was resolved (settled/ruled).  |
| `ESCROW_CANCELLED`     | The escrow was cancelled by a party.      |

---

## Architecture & Integration

The entry-point is `EscrowHooks.onEscrowEvent` in `src/hooks/escrow.hooks.ts`.

```
KeyEscrowEvent
      │
      ▼
EscrowHooks.onEscrowEvent(event, payload)
      │
      ├─── notificationService.sendEmail(...)       ──► Email transport (SMTP/SES/SendGrid)
      │
      └─── notificationService.sendWebNotification(...) ──► Web/in-app transport + DB persist
```

---

## Dispatch Semantics (Promise.allSettled fan-out)

`onEscrowEvent` fans out to **all channels concurrently** using
`Promise.allSettled`. This is a deliberate choice over `Promise.all`:

| Behaviour          | `Promise.all`                    | `Promise.allSettled` (current)         |
| ------------------ | -------------------------------- | -------------------------------------- |
| One channel throws | Entire dispatch is aborted early | Other channels still run to completion |
| Return value       | `void`                           | `EscrowDispatchResult` (typed result)  |
| Partial failures   | Silently suppressed              | Logged and reported per-channel        |

### Return type — `EscrowDispatchResult`

```ts
interface EscrowChannelResult {
  channel: 'email' | 'web';
  success: boolean;
  message?: string;   // present only on failure
}

interface EscrowDispatchResult {
  allSucceeded: boolean;   // true only when every channel succeeded
  anySucceeded: boolean;   // true when at least one channel succeeded
  channels: EscrowChannelResult[];  // one entry per channel
}
```

Callers can inspect `channels` to decide on per-channel retry or alerting
strategies without re-running the full dispatch.

### Log output summary

Each call to `onEscrowEvent` produces log records at the following levels
depending on the aggregate outcome:

| Outcome               | Aggregate log level | Per-channel log level              |
| --------------------- | ------------------- | ---------------------------------- |
| All channels succeed  | `info`              | `info` per channel                 |
| One channel fails     | `warn`              | `error` for the failing channel    |
| All channels fail     | `error`             | `error` per channel                |

Fields included in every log record: `contractId`, `userId`, `event`,
`channel`. **No PII** (e.g. email addresses, message bodies) is written to
logs.

---

## Security Notes

1. **No PII in logs** — Only `contractId` and `userId` are written as
   correlation identifiers. Raw email addresses and message bodies are never
   serialised into log records.

2. **Email address validation** — `NotificationService` validates the `to`
   address with a regex check (must match `user@domain.tld`) and rejects
   addresses containing CR/LF characters before passing them to the transport
   layer, preventing header-injection attacks.

3. **User ID validation** — `sendWebNotification` rejects user IDs that
   contain CR/LF characters to prevent IDOR-adjacent log-injection vectors.

4. **Transport isolation** — A failure in the email transport (network error,
   SMTP authentication failure) cannot prevent the web notification from being
   delivered, and vice versa.

5. **IDOR on web notifications** — Dispatching web notifications requires that
   the session `userId` matches authorization domains. Callers are responsible
   for validating `userId` before invoking the hook.

6. **DoS / Rate limiting** — Sending alerts concurrently reduces I/O stalls,
   but rate limits should be applied per-destination downstream to prevent
   systemic email flooding.

---

## Example usage

```ts
import { EscrowHooks } from '../hooks/escrow.hooks';
import { KeyEscrowEvent } from '../types/notification.types';

const result = await EscrowHooks.onEscrowEvent(KeyEscrowEvent.FUNDS_DEPOSITED, {
  contractId: 'C123',
  userEmail: 'user@example.com',
  userId: 'user-abc',
  amount: '500 USDC',
});

if (!result.allSucceeded) {
  const failed = result.channels.filter(c => !c.success);
  // schedule per-channel retry for `failed` entries
}
```
