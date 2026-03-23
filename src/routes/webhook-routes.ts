import { Router, type Request } from 'express';

import type { WebhookConfig } from '../config/webhook-config';
import { ApiError } from '../errors/ApiError';
import { WebhookSignatureService } from '../services/webhook-signature-service';
import { WebhookService } from '../services/webhook-service';
import type { BlockchainWebhookPayload } from '../types/webhook';

/**
 * @notice Build the signed blockchain webhook endpoint with injected services.
 * @param webhookConfig Webhook runtime configuration.
 * @param signatureService Service that verifies signed deliveries.
 * @param webhookService Service that validates and processes verified events.
 */
export function createWebhookRouter(
  webhookConfig: WebhookConfig,
  signatureService: WebhookSignatureService,
  webhookService: WebhookService,
): Router {
  const router = Router();

  router.post('/webhooks/blockchain', (req, res) => {
    const rawBody = extractRawBody(req);

    signatureService.verify(rawBody, {
      signature: readHeader(req, webhookConfig.signatureHeader),
      timestamp: readHeader(req, webhookConfig.timestampHeader),
    });

    const payload = parseWebhookJson(rawBody);
    const result = webhookService.handleVerifiedPayload(
      payload,
      readHeader(req, webhookConfig.eventIdHeader),
    );

    if (result.duplicate) {
      res.status(200).json({ status: 'already_processed' });
      return;
    }

    res.status(202).json({ status: 'acknowledged' });
  });

  return router;
}

/**
 * @notice Extract the raw request body captured by the route-specific parser.
 * @param request Express request object.
 */
export function extractRawBody(request: Request): Buffer {
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    throw new ApiError(400, 'Webhook body is required.');
  }

  return request.body;
}

/**
 * @notice Parse the verified JSON payload from the raw body.
 * @param rawBody Exact bytes received from the provider.
 */
export function parseWebhookJson(rawBody: Buffer): BlockchainWebhookPayload {
  try {
    return JSON.parse(rawBody.toString('utf8')) as BlockchainWebhookPayload;
  } catch {
    throw new ApiError(400, 'Webhook payload must be valid JSON.');
  }
}

/**
 * @notice Read a normalized single-value header from the request.
 * @param request Express request object.
 * @param headerName Lowercase header name.
 */
export function readHeader(request: Request, headerName: string): string | undefined {
  const rawValue = request.header(headerName);
  return typeof rawValue === 'string' ? rawValue : undefined;
}
