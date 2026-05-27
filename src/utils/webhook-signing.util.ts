import { createHmac } from 'crypto';

export interface WebhookSignature {
  signature: string;
  timestamp: number;
}

/**
 * Generates an HMAC signature for webhook payloads
 * @param payload The webhook payload to sign
 * @param secret The secret key used for signing
 * @param timestamp The timestamp to include in the signature
 * @returns The HMAC signature
 */
export function generateSignature(
  payload: unknown,
  secret: string,
  timestamp: number
): string {
  // Create the canonical string: timestamp + JSON.stringify(payload)
  const canonicalString = `${timestamp}.${JSON.stringify(payload)}`;
  
  // Generate HMAC-SHA256 signature
  const hmac = createHmac('sha256', secret);
  hmac.update(canonicalString);
  
  return hmac.digest('hex');
}

/**
 * Creates webhook signature headers
 * @param payload The webhook payload to sign
 * @param secret The secret key used for signing
 * @returns Object containing signature and timestamp
 */
export function createWebhookSignature(
  payload: unknown,
  secret: string
): WebhookSignature {
  const timestamp = Date.now();
  const signature = generateSignature(payload, secret, timestamp);
  
  return {
    signature,
    timestamp
  };
}

/**
 * Verifies a webhook signature
 * @param payload The webhook payload that was received
 * @param signature The signature from the X-Signature header
 * @param timestamp The timestamp from the X-Timestamp header
 * @param secret The secret key used for verification
 * @returns True if the signature is valid, false otherwise
 */
export function verifySignature(
  payload: unknown,
  signature: string,
  timestamp: number,
  secret: string
): boolean {
  // Check if timestamp is too old (5 minutes)
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes in milliseconds
  
  if (now - timestamp > maxAge) {
    return false;
  }
  
  // Generate expected signature
  const expectedSignature = generateSignature(payload, secret, timestamp);
  
  // Compare signatures using constant-time comparison
  return constantTimeCompare(signature, expectedSignature);
}

/**
 * Constant-time comparison to prevent timing attacks
 * @param a First string to compare
 * @param b Second string to compare
 * @returns True if strings are equal, false otherwise
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}
