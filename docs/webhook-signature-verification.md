# Webhook Signature Verification

This document outlines the security assumptions, design principles, and implementation details for the webhook signature verification system in the TalentTrust backend.

## Overview

All outbound webhooks from the Talenttrust Backend are signed using HMAC-SHA256 when a webhook secret is configured. This ensures the authenticity and integrity of webhook payloads.

## Headers

When HMAC signing is enabled, the following headers are included with each webhook request:

- `X-Signature`: The HMAC signature prefixed with `sha256=`
- `X-Timestamp`: Unix timestamp (milliseconds) when the signature was generated
- `Content-Type`: Always set to `application/json`

## Signature Generation Process

The signature is generated using the following process:

1. **Canonical String Creation**: Create a string in the format `{timestamp}.{payload}`
   - `timestamp`: Unix timestamp in milliseconds
   - `payload`: The JSON stringified webhook payload

2. **HMAC Calculation**: Calculate HMAC-SHA256 using the webhook secret
   - Input: Canonical string
   - Key: Webhook secret
   - Output: Hex-encoded HMAC digest

3. **Header Format**: The signature is sent as `sha256={hex_digest}`

## Verification Steps

To verify a webhook signature:

### 1. Extract Headers

```javascript
const signature = request.headers['x-signature'];
const timestamp = parseInt(request.headers['x-timestamp']);
```

### 2. Verify Timestamp

Check that the timestamp is not too old (recommended: 5 minutes):

```javascript
const now = Date.now();
const maxAge = 5 * 60 * 1000; // 5 minutes

if (now - timestamp > maxAge) {
  throw new Error('Webhook timestamp is too old');
}
```

### 3. Recreate Signature

Create the canonical string and generate the expected signature:

```javascript
import { createHmac } from 'crypto';

function verifySignature(payload, signature, timestamp, secret) {
  // Remove the sha256= prefix
  const receivedSignature = signature.replace('sha256=', '');
  
  // Create canonical string
  const canonicalString = `${timestamp}.${JSON.stringify(payload)}`;
  
  // Generate expected signature
  const hmac = createHmac('sha256', secret);
  hmac.update(canonicalString);
  const expectedSignature = hmac.digest('hex');
  
  // Compare signatures (use constant-time comparison)
  return constantTimeCompare(receivedSignature, expectedSignature);
}

function constantTimeCompare(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}
```

### 4. Complete Verification Example

```javascript
import express from 'express';
import { createHmac } from 'crypto';

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = 'your-webhook-secret-here';

function verifyWebhook(payload, signature, timestamp, secret) {
  // Check timestamp age
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  
  if (now - timestamp > maxAge) {
    return false;
  }
  
  // Remove prefix and recreate signature
  const receivedSignature = signature.replace('sha256=', '');
  const canonicalString = `${timestamp}.${JSON.stringify(payload)}`;
  
  const hmac = createHmac('sha256', secret);
  hmac.update(canonicalString);
  const expectedSignature = hmac.digest('hex');
  
  // Constant-time comparison
  return constantTimeCompare(receivedSignature, expectedSignature);
}

function constantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

app.post('/webhook', (req, res) => {
  try {
    const signature = req.headers['x-signature'];
    const timestamp = parseInt(req.headers['x-timestamp']);
    
    if (!signature || !timestamp) {
      return res.status(400).json({ error: 'Missing signature headers' });
    }
    
    const isValid = verifyWebhook(req.body, signature, timestamp, WEBHOOK_SECRET);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    
    // Process valid webhook
    console.log('Webhook verified successfully:', req.body);
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('Webhook verification error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
```

## Security Best Practices

1. **Never expose webhook secrets in logs or error messages**
2. **Use constant-time comparison to prevent timing attacks**
3. **Implement timestamp validation to prevent replay attacks**
4. **Store webhook secrets securely (environment variables, secret management)**
5. **Rotate webhook secrets periodically**
6. **Monitor for failed signature verifications**

## Language-Specific Examples

### Python

```python
import hmac
import hashlib
import time
from flask import Flask, request, jsonify

app = Flask(__name__)
WEBHOOK_SECRET = 'your-webhook-secret-here'

def verify_signature(payload, signature, timestamp, secret):
    # Check timestamp age (5 minutes)
    if time.time() * 1000 - timestamp > 5 * 60 * 1000:
        return False
    
    # Remove sha256= prefix
    received_signature = signature.replace('sha256=', '')
    
    # Create canonical string
    canonical_string = f"{timestamp}.{payload}"
    
    # Generate expected signature
    expected_signature = hmac.new(
        secret.encode(),
        canonical_string.encode(),
        hashlib.sha256
    ).hexdigest()
    
    # Constant-time comparison
    return hmac.compare_digest(received_signature, expected_signature)

@app.route('/webhook', methods=['POST'])
def webhook():
    signature = request.headers.get('X-Signature')
    timestamp = int(request.headers.get('X-Timestamp', 0))
    
    if not signature or not timestamp:
        return jsonify({'error': 'Missing signature headers'}), 400
    
    payload = request.get_data(as_text=True)
    
    if not verify_signature(payload, signature, timestamp, WEBHOOK_SECRET):
        return jsonify({'error': 'Invalid webhook signature'}), 401
    
    # Process valid webhook
    return jsonify({'received': True}), 200
```

### Ruby

```ruby
require 'openssl'
require 'json'
require 'sinatra'

WEBHOOK_SECRET = 'your-webhook-secret-here'

def verify_signature(payload, signature, timestamp, secret)
  # Check timestamp age (5 minutes)
  return false if (Time.now.to_f * 1000 - timestamp) > 5 * 60 * 1000
  
  # Remove sha256= prefix
  received_signature = signature.sub('sha256=', '')
  
  # Create canonical string
  canonical_string = "#{timestamp}.#{payload}"
  
  # Generate expected signature
  expected_signature = OpenSSL::HMAC.hexdigest(
    'sha256',
    secret,
    canonical_string
  )
  
  # Constant-time comparison
  OpenSSL.secure_compare(received_signature, expected_signature)
end

post '/webhook' do
  signature = request.env['HTTP_X_SIGNATURE']
  timestamp = request.env['HTTP_X_TIMESTAMP']&.to_i
  
  if signature.nil? || timestamp.nil?
    halt 400, { error: 'Missing signature headers' }.to_json
  end
  
  payload = request.body.read
  
  unless verify_signature(payload, signature, timestamp, WEBHOOK_SECRET)
    halt 401, { error: 'Invalid webhook signature' }.to_json
  end
  
  # Process valid webhook
  content_type :json
  { received: true }.to_json
end
```
## Delivery-Time Security Guards

Two additional guards run **before every delivery attempt** (including retries) inside `WebhookService.send`.

### SSRF Re-check

The destination URL is validated by `isSafeUrl` (from `src/utils/ssrf.ts`) on each attempt. If the URL resolves to a private or loopback address (including RFC-1918 ranges, `localhost`, and the link-local metadata range `169.254.x.x`) the delivery is **immediately moved to the DLQ** with error code `SSRF_BLOCKED`. No retry is attempted.

This re-check on every attempt guards against DNS rebinding attacks where an initially safe hostname is later made to resolve to an internal IP.

### Per-Host Rate Limiting

A sliding-window counter tracks deliveries per destination hostname. The counter is keyed by hostname (hashed via SHA-256 inside `RateLimitStore`) and shared across all `WebhookService` instances within a process.

If the limit is exceeded the delivery is **immediately moved to the DLQ** with error code `RATE_LIMITED`. No retry is attempted.

| Environment variable | Default | Description |
|---|---|---|
| `WEBHOOK_HOST_RATE_LIMIT_MAX` | `60` | Maximum deliveries per host per window |
| `WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS` | `60000` | Window length in milliseconds |

### Error Codes in DLQ

| Code | Cause |
|---|---|
| `SSRF_BLOCKED: ...` | Destination URL failed the SSRF safety check |
| `RATE_LIMITED: host <hostname> exceeded delivery limit` | Per-host delivery cap reached |

---

## Webhook Delivery Retry Policy

The Talenttrust Backend implements exponential backoff with jitter for webhook delivery to handle transient failures gracefully. Failed deliveries are automatically retried before being enqueued to the Dead Letter Queue (DLQ).

### Transient vs. Non-Transient Failures

**Transient failures (automatically retried):**
- HTTP 5xx Server Errors (500, 502, 503, etc.)
- Network timeouts (ETIMEDOUT)
- Connection resets (ECONNRESET, ECONNABORTED)
- DNS resolution failures (ENOTFOUND)
- Connection refused errors (ECONNREFUSED)

**Non-transient failures (not retried, immediate failure):**
- HTTP 4xx Client Errors (400, 401, 404, etc.)
- Invalid HMAC signatures
- Validation errors

### Retry Behavior

When a webhook delivery fails due to a transient error:

1. The backend waits for a delay calculated using exponential backoff with jitter
2. The webhook is retried with the **original signature and timestamp** (signature is not re-signed)
3. If the retry succeeds, the delivery is recorded and no further action is taken
4. If all retries are exhausted, the webhook is enqueued to the DLQ for manual inspection and replay

### Configuration

Webhook retry behavior is configured via environment variables:

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `WEBHOOK_RETRY_MAX_ATTEMPTS` | `5` | `1` | `20` | Maximum number of delivery attempts (including initial attempt) |
| `WEBHOOK_RETRY_INITIAL_DELAY_MS` | `1000` | `100` | `60000` | Initial retry delay in milliseconds |
| `WEBHOOK_RETRY_MAX_DELAY_MS` | `30000` | `1000` | `600000` | Maximum retry delay in milliseconds (caps exponential backoff) |
| `WEBHOOK_RETRY_MULTIPLIER` | `2` | `1` | `10` | Exponential backoff multiplier (e.g., 2 = double each retry) |
| `WEBHOOK_RETRY_JITTER_FACTOR` | `0.1` | `0` | `1` | Jitter factor as fraction of delay (e.g., 0.1 = ±10%) |

### Example Retry Schedule

With default configuration (5 attempts, 1s initial delay, 2x multiplier, 0.1 jitter):

```
Attempt 1: Initial (no delay)
Attempt 2: ~1000ms ± 100ms
Attempt 3: ~2000ms ± 200ms
Attempt 4: ~4000ms ± 400ms
Attempt 5: ~8000ms ± 800ms

Total time: ~15-18 seconds
```

### Jitter Explanation

Jitter prevents the "thundering herd" problem where many webhooks retry simultaneously after an outage. Instead of all retries happening at the same time, they're spread out randomly within the calculated delay window.

Formula: `delay = baseDelay * (multiplier ^ attemptNumber) ± (delay * jitterFactor * random())`

### Metrics

The backend emits the following metrics related to webhook retry:

- `webhook_delivery_retries_total{provider,reason}` - Total number of delivery retries by provider and failure reason
- `webhook_delivery_attempts_total{status,provider,reason}` - Total delivery attempts (initial + retries)
- `webhook_delivery_latency_seconds{status,provider}` - Delivery latency histogram

### HMAC Signature Preservation During Retries

**Important:** When a webhook is retried, the original HMAC signature and timestamp headers are preserved exactly as signed. The webhook is not re-signed with a new timestamp. This ensures:

1. Signature verification remains valid across all retry attempts
2. Timestamp validation windows are consistent
3. No security gaps or signature mismatches occur

If you implement timestamp validation on the receiving end, allow a sufficiently large window (e.g., 5-10 minutes) to account for retries that may occur after initial delivery failure.

### DLQ Behavior

When webhook delivery exhausts all retries:

1. The webhook entry is enqueued to the DLQ (Dead Letter Queue)
2. The final failure reason is recorded for investigation
3. Operators can inspect and manually replay failed webhooks
4. Each DLQ entry includes the original payload, provider, URL, and error context

For details on DLQ operations, see [WEBHOOK-DLQ.md](./WEBHOOK-DLQ.md).

## Backend verification API

Inbound verification is implemented in `src/utils/webhook-signing.util.ts` and re-exported from `src/webhookDelivery.ts` for route handlers that already depend on the delivery module.

| Function | Purpose |
|----------|---------|
| `verifyWebhookSignature(payload, signature, timestamp, secret, options?)` | Structured result with safe error codes/messages |
| `verifySignature(...)` | Boolean convenience wrapper |
| `normalizeSignatureHeader(signature)` | Strips `sha256=` and validates hex |
| `constantTimeCompareHex(a, b)` | `crypto.timingSafeEqual` on decoded digests |

Failure messages are passed through `src/errors/safeErrors.ts` so stack traces, file paths, and secrets never reach clients. Signature mismatch uses the `invalid_webhook_signature` code.

### Adversarial / property tests

CI runs a deterministic fuzz suite (`FUZZ_SEED = 0x277a11ce`, 400 iterations) in `src/webhookDelivery.signature.property.test.ts`. Generated inputs include:

- Random and truncated hex digests
- Wrong-length HMACs and `sha256=` prefix variants
- Base64 and non-hex encodings
- Expired timestamps and tampered payloads

**Acceptance criteria:** zero forgeries accepted; no unhandled throws; constant-time comparison exercised via `crypto.timingSafeEqual`.

Run locally:

```bash
npm test -- webhook-signing.util.test.ts webhookDelivery.signature.property.test.ts
npm run test:ci -- --collectCoverageFrom='src/utils/webhook-signing.util.ts'
```

## Testing

You can test webhook signature verification using our utility functions:

```javascript
import { createWebhookSignature, verifySignature } from './utils/webhook-signing.util';

// Test signature creation and verification
const payload = { event: 'user.created', data: { id: '123' } };
const secret = 'test-secret';

const { signature, timestamp } = createWebhookSignature(payload, secret);
const isValid = verifySignature(payload, signature, timestamp, secret);

console.log('Signature valid:', isValid); // Should be true
```

## Troubleshooting

### Common Issues

1. **"Invalid webhook signature"**
   - Check that you're using the correct webhook secret
   - Ensure you're parsing the JSON payload exactly as sent
   - Verify you're removing the `sha256=` prefix before comparison

2. **"Webhook timestamp is too old"**
   - Check server clock synchronization
   - Ensure you're using milliseconds, not seconds
   - Consider adjusting the maximum age threshold

3. **"Missing signature headers"**
   - Ensure webhook secret is configured in Talenttrust Backend
   - Check that headers are being forwarded correctly by proxies/load balancers

### Debugging Steps

1. Log the canonical string being used for signature generation
2. Compare the expected and received signatures character by character
3. Verify the payload JSON matches exactly (including whitespace)
4. Check that timestamps are in milliseconds

## Support

If you encounter issues with webhook signature verification, please:

1. Check this documentation for common solutions
2. Verify your implementation against the examples provided
3. Contact support with details about your implementation and specific error messages
