# Webhook Ingestion Endpoint

## Overview

The backend now exposes a signed blockchain webhook intake endpoint:

- `POST /webhooks/blockchain`

The endpoint is intentionally narrow and verifies authenticity before it parses or processes an event.

## Signature model

The implementation uses an HMAC-SHA256 signature over:

```text
<timestamp>.<raw-request-body>
```

Expected headers by default:

- `X-Webhook-Signature`
- `X-Webhook-Timestamp`
- `X-Webhook-Id`

Supported signature formats:

- `sha256=<hex-digest>`
- `<hex-digest>`

The backend compares the supplied and expected digests with a constant-time comparison primitive.

## Raw body requirement

Signature verification uses the exact raw request body bytes captured by the route-specific parser. This avoids false positives from JSON reformatting, whitespace differences, or object re-serialization.

## Replay and idempotency strategy

The current implementation uses an in-memory replay-protection store:

- stale timestamps outside the configured tolerance are rejected
- duplicate delivery ids are acknowledged without reprocessing
- failed processing releases the reservation so a provider retry can succeed

This keeps duplicate deliveries from causing duplicate business effects in the current single-process architecture.

## Supported event types

The current normalized event types are:

- `contract.metadata.updated`
- `contract.payment.released`

Unknown event types are rejected with a safe `400` response.

## Configuration

Environment variables:

- `WEBHOOK_SECRET`
- `WEBHOOK_SIGNATURE_HEADER` default `x-webhook-signature`
- `WEBHOOK_TIMESTAMP_HEADER` default `x-webhook-timestamp`
- `WEBHOOK_EVENT_ID_HEADER` default `x-webhook-id`
- `WEBHOOK_MAX_AGE_SECONDS` default `300`
- `WEBHOOK_RAW_BODY_LIMIT` default `64kb`

If `WEBHOOK_SECRET` is missing, the route remains mounted but responds with `503` so configuration errors are explicit and easy to detect in non-production environments.

## Response behavior

- verified new delivery: `202 { "status": "acknowledged" }`
- verified duplicate delivery: `200 { "status": "already_processed" }`
- invalid or stale signature: `401 { "error": "Invalid webhook signature." }`
- malformed verified payload: `400` with a safe validation message
- processor failure: `500 { "error": "Internal server error." }`

## Local testing

Run the test suite:

```bash
npm test -- --runInBand
npx jest --coverage --runInBand
```

To exercise the route manually, set a local webhook secret first:

```bash
$env:WEBHOOK_SECRET="local-test-secret"
npm run dev
```

Then generate a signature over the raw JSON payload with the same secret and send the request to `POST /webhooks/blockchain`.

## Security assumptions and threat scenarios

Validated:

- forged unsigned requests are rejected
- altered payloads fail signature verification
- stale timestamps are rejected
- duplicate delivery ids do not trigger duplicate processing
- processing errors do not leak internal details
- the endpoint does not rely on live blockchain providers in tests

Threat scenarios considered:

- signature bypass through JSON re-serialization
- replay of previously valid payloads
- duplicate provider retries
- denial-of-service through oversized bodies
- secret leakage through logs or responses

## Limitations

- Replay protection is currently process-local because the repo does not yet use persistent storage or Redis.
- Duplicate suppression is therefore scoped to a single running instance.
- Future multi-instance deployments should move the delivery store to shared persistence.
