import axios from 'axios';
import { createWebhookSignature } from '../utils/webhook-signing.util';
import { getWebhookDLQStorage, WebhookDLQEntry } from '../queue/webhook-dlq';
import { WEBHOOK_RETRY_POLICY, calculateWebhookRetryDelay } from '../queue/webhook-retry-policy';

export interface WebhookPayload {
  id: string;
  url: string;
  data: unknown;
  retryCount: number;
  webhookSecret?: string;
}

export class WebhookService {
  private dlqStorage = getWebhookDLQStorage();

  async send(payload: WebhookPayload): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (payload.webhookSecret) {
        const { signature, timestamp } = createWebhookSignature(
          payload.data,
          payload.webhookSecret
        );
        
        headers['X-Signature'] = `sha256=${signature}`;
        headers['X-Timestamp'] = timestamp.toString();
      }

      await axios.post(payload.url, payload.data, { headers });
    } catch (error: unknown) {
      const err = error as Error;
      if (payload.retryCount < WEBHOOK_RETRY_POLICY.maxRetries) {
        const delay = calculateWebhookRetryDelay(payload.retryCount);
        payload.retryCount++;

        await new Promise(resolve => setTimeout(resolve, delay));
        await this.send(payload);
      } else {
        await this.persistToDLQ(payload, err.message);
      }
    }
  }

  private async persistToDLQ(payload: WebhookPayload, error: string): Promise<void> {
    try {
      await this.dlqStorage.addEntry(
        payload.id,
        payload.url,
        payload.data as Record<string, unknown>,
        payload.retryCount,
        error,
        payload.webhookSecret
      );
    } catch (err: unknown) {
      if ((err as Error).message === 'DUPLICATE_ENTRY') {
        return;
      }
      throw err;
    }
  }

  getDLQ(): Omit<WebhookDLQEntry, 'webhookSecret'>[] {
    const entries = this.dlqStorage.listEntries();
    return entries.map(entry => {
      const { webhookSecret, ...rest } = entry;
      return rest;
    });
  }

  async getDLQEntry(id: string): Promise<Omit<WebhookDLQEntry, 'webhookSecret'> | null> {
    const entry = this.dlqStorage.getEntry(id);
    if (!entry) return null;
    const { webhookSecret, ...rest } = entry;
    return rest;
  }

  async replayDLQEntry(id: string): Promise<{ success: boolean; message: string }> {
    const entry = this.dlqStorage.getEntry(id);
    if (!entry) {
      return { success: false, message: 'Entry not found' };
    }

    if (entry.replayedAt) {
      return { success: false, message: 'Entry already replayed' };
    }

    const dedupe = this.dlqStorage.checkDedupe(entry.webhookId, entry.body);
    if (dedupe.exists) {
      this.dlqStorage.markReplayed(id);
      return { success: true, message: 'Deduplicated - entry already pending replay' };
    }

    try {
      await this.send({
        id: entry.webhookId,
        url: entry.url,
        data: entry.body,
        retryCount: 0,
        webhookSecret: entry.webhookSecret,
      });
      this.dlqStorage.markReplayed(id);
      return { success: true, message: 'Replay successful' };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }

  async getDLQStats(): Promise<{ total: number; pending: number; replayed: number }> {
    return this.dlqStorage.getStats();
  }
}