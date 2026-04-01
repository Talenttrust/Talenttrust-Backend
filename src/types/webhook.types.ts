export interface WebhookPayload {
  id: string;
  url: string;
  event: string;
  data: any;
  retryCount: number;
}

export interface DLQEntry extends WebhookPayload {
  failedAt: Date;
  lastError: string;
}