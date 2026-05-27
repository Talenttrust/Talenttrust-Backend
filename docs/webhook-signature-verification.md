# Webhook Signature Verification

This document explains how to verify webhook signatures sent by the Talenttrust Backend using HMAC-SHA256 signing.

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
