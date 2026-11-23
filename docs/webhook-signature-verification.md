# Webhook Signature Verification

This document explains how outbound webhooks from the TalentTrust Backend are signed and how integrators should verify them. All signing, delivery, and verification logic lives in [`src/webhooks.ts`](../src/webhooks.ts).

## Overview

Every outbound webhook delivered by `WebhookManager.deliver` in `src/webhooks.ts` is signed with HMAC-SHA256. When a webhook subscription is created (or its secret is rotated via `rotateSecret`), the backend automatically generates a `whsec_`-prefixed secret (`whsec_<base64>`). Signing is always enabled on every delivery.

## Headers

Every webhook `POST` request includes the following headers:

| Header | Description |
| --- | --- |
| `Content-Type` | Always `application/json` |
| `X-Signature` | HMAC-SHA256 digest formatted as `sha256=<64-char-hex>` |
| `X-Timestamp` | Unix timestamp in **milliseconds** when the attempt was signed |
| `X-Event-Type` | Event type name (for example `escrow.created`) |
| `X-Event-ID` | Unique identifier for the emitted event |
| `X-Delivery-ID` | Unique identifier for the delivery record |

## Signature Format

For each delivery attempt, `WebhookManager.deliver` computes the signature over the exact raw JSON body:

```text
canonicalString = `${timestamp}.${rawBody}`
signature       = HMAC-SHA256(secret, canonicalString).digest('hex')
X-Signature     = `sha256=${signature}`
```

- `secret` is the full `whsec_...` string returned when the subscription was created or rotated.
- `timestamp` is the integer millisecond value sent in `X-Timestamp`.
- `rawBody` is the exact UTF-8 JSON request body bytes received over the wire. Do **not** parse and re-serialize with `JSON.stringify(req.body)`, as whitespace or key-order differences will invalidate the signature.

## Built-in Verification Helper

`src/webhooks.ts` exports `verifyWebhookSignature`:

```ts
verifyWebhookSignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  toleranceSec = 300,
): boolean
```

### Parameters

- `secret`: The subscription's `whsec_...` signing secret.
- `headers`: The incoming request headers object (header names are matched case-insensitively, and `string[]` values use the first entry).
- `rawBody`: The raw UTF-8 request body string.
- `toleranceSec`: Maximum allowed clock skew / age in seconds (defaults to `300`, i.e., 5 minutes).

### What It Checks

1. Extracts `x-signature` and `x-timestamp` from `headers`.
2. Parses `x-timestamp` as an integer (milliseconds) and verifies `Math.abs(Date.now() - timestamp) <= toleranceSec * 1000`.
3. Validates that `x-signature` matches `^sha256=([0-9a-f]{64})$` (case-insensitive).
4. Computes `HMAC-SHA256(secret, `${timestamp}.${rawBody}`)`.
5. Compares the decoded digests in constant time using `crypto.timingSafeEqual`.

## Node.js Example

### Express Receiver Using `verifyWebhookSignature`

Capture the raw body before JSON parsing so verification runs on the exact bytes sent by `WebhookManager.deliver`:

```ts
import express from 'express';
import { verifyWebhookSignature } from '../src/webhooks';

const app = express();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!; // e.g. "whsec_..."

app.post(
  '/webhooks/talenttrust',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

    const valid = verifyWebhookSignature(WEBHOOK_SECRET, req.headers, rawBody, 300);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const event = JSON.parse(rawBody);
    const eventId = req.header('X-Event-ID');
    const eventType = req.header('X-Event-Type');
    const deliveryId = req.header('X-Delivery-ID');

    console.log('Verified webhook', { eventId, eventType, deliveryId, event });
    return res.status(200).json({ received: true });
  },
);
```

### Standalone Node.js Verification (Without Importing Backend Code)

If your receiver lives in a separate repository, you can implement the exact same check using Node's built-in `crypto` module:

```js
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export function verifyTalentTrustWebhook(secret, headers, rawBody, toleranceSec = 300) {
  const getHeader = (name) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    const value = key ? headers[key] : undefined;
    return Array.isArray(value) ? value[0] : value;
  };

  const signature = getHeader('x-signature');
  const timestamp = Number(getHeader('x-timestamp'));

  if (!signature || !Number.isInteger(timestamp)) return false;
  if (Math.abs(Date.now() - timestamp) > toleranceSec * 1000) return false;

  const match = signature.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;

  const expectedHex = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const received = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();

  return timingSafeEqual(a, b) && received.length === expected.length;
}
```

## Replay-Window Recommendation

- Keep `toleranceSec` at the default **300 seconds (5 minutes)** unless you have a specific operational reason to tighten it (for example, 60–300 seconds).
- `verifyWebhookSignature` checks `Math.abs(Date.now() - timestamp) <= toleranceSec * 1000`, which rejects both stale deliveries and timestamps too far in the future.
- For stronger replay protection, record processed `X-Event-ID` (or `X-Delivery-ID`) values in a short-lived cache (TTL at least `toleranceSec`) and ignore duplicates.
- Note that `WebhookManager.deliver` retries transient failures (5xx and network/timeout errors) up to 6 attempts with exponential backoff and ±10% jitter, generating a fresh `X-Timestamp` and signature on each attempt, while 4xx responses are not retried.

## Delivery URL Security

Before every delivery attempt, `WebhookManager.deliver` validates the subscription URL using `validateWebhookUrl` in `src/webhooks.ts`. It requires HTTPS (allowing `http://localhost` only outside production) and blocks private, loopback, link-local, multicast, and reserved IPv4/IPv6 addresses—including after DNS resolution.

## Testing

Webhook delivery, signing, URL validation, and `verifyWebhookSignature` are covered in [`tests/webhooks.test.ts`](../tests/webhooks.test.ts). Run the suite with:

```bash
npm test -- tests/webhooks.test.ts
```

## Troubleshooting

- **Signature mismatch**: Confirm you are verifying the raw UTF-8 request body (not `JSON.stringify(req.body)`), using the full `whsec_...` secret, and keeping the `sha256=` prefix intact when calling `verifyWebhookSignature`.
- **Timestamp rejected**: Confirm your server clock is synchronized via NTP and that `X-Timestamp` is treated as **milliseconds**, not seconds.
- **Missing headers**: Ensure reverse proxies or API gateways forward `X-Signature`, `X-Timestamp`, `X-Event-Type`, `X-Event-ID`, and `X-Delivery-ID`.
