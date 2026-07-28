export interface WebhookPayload {
  id: string;
  url: string;
  event: string;
  data: any;
  retryCount: number;
  webhookSecret?: string;
}

export interface DLQEntry extends WebhookPayload {
  failedAt: Date;
  lastError: string;
}

/** Subscription model for per‑consumer webhook endpoints */
export interface WebhookSubscription {
  id: string;
  consumerId?: string; // optional if not tied to a consumer entity
  url: string;
  eventType: string;
  secret?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** DTOs used by the subscription API */
export interface CreateWebhookSubscriptionDto {
  consumerId?: string;
  url: string;
  eventType: string;
  secret?: string;
}

export interface UpdateWebhookSubscriptionDto {
  url?: string;
  eventType?: string;
  secret?: string;
  active?: boolean;
}