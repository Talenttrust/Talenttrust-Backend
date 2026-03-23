/**
 * @notice Runtime configuration for the signed blockchain webhook endpoint.
 */
export interface WebhookConfig {
  secret: string;
  signatureHeader: string;
  timestampHeader: string;
  eventIdHeader: string;
  maxAgeSeconds: number;
  rawBodyLimit: string;
}

/**
 * @notice Load webhook configuration from environment variables.
 * @param env Environment variable source used in production and tests.
 */
export function loadWebhookConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebhookConfig {
  return {
    secret: (env.WEBHOOK_SECRET ?? '').trim(),
    signatureHeader: (env.WEBHOOK_SIGNATURE_HEADER ?? 'x-webhook-signature').toLowerCase(),
    timestampHeader: (env.WEBHOOK_TIMESTAMP_HEADER ?? 'x-webhook-timestamp').toLowerCase(),
    eventIdHeader: (env.WEBHOOK_EVENT_ID_HEADER ?? 'x-webhook-id').toLowerCase(),
    maxAgeSeconds: parsePositiveInteger(env.WEBHOOK_MAX_AGE_SECONDS, 300),
    rawBodyLimit: env.WEBHOOK_RAW_BODY_LIMIT ?? '64kb',
  };
}

/**
 * @notice Parse a positive integer environment value safely.
 * @param value Raw environment value.
 * @param fallback Value used when the input is absent or invalid.
 */
export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
