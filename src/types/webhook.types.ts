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