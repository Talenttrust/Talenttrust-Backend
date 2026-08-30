import { WebhookService } from './webhook.service';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';
import { getDb, closeDb } from '../db/database';
import axios from 'axios';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../utils/webhook-signing.util', () => ({
  createWebhookSignature: jest.fn().mockImplementation((data, secret) => ({
    signature: `sig-for-${secret}`,
    timestamp: 1234567890,
  })),
}));

describe('Webhook Delivery Tenant Isolation', () => {
  let webhookService: WebhookService;
  let repo: SqliteWebhookSubscriptionRepository;

  beforeAll(() => {
    // Force in-memory fresh DB
    getDb(':memory:', { runMigrations: true });
    repo = new SqliteWebhookSubscriptionRepository(getDb());
    webhookService = new WebhookService();
  });

  afterAll(() => {
    closeDb();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('delivers only to the matching tenant (tenant mismatch)', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: 'OK' });

    // Create subscription for tenant A
    await repo.create({
      tenantId: 'tenant-a',
      eventType: 'contract.created',
      url: 'http://tenant-a.com/webhook',
      secret: 'secret-a',
    });
    // Create subscription for tenant B
    await repo.create({
      tenantId: 'tenant-b',
      eventType: 'contract.created',
      url: 'http://tenant-b.com/webhook',
      secret: 'secret-b',
    });

    // Trigger event for tenant A
    await webhookService.trigger('contract.created', { id: 1 }, undefined, 'tenant-a');

    // Wait for async delivery
    await new Promise((r) => setTimeout(r, 100));

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      'http://tenant-a.com/webhook',
      { id: 1 },
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Signature': 'sha256=sig-for-secret-a'
        })
      })
    );
  });

  it('missing config: handles event with no matching tenant config gracefully', async () => {
    await expect(webhookService.trigger('contract.created', { id: 2 }, undefined, 'tenant-c')).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('rotated secret: uses the updated secret for signature', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: 'OK' });
    const sub = await repo.create({
      tenantId: 'tenant-d',
      eventType: 'item.updated',
      url: 'http://tenant-d.com/webhook',
      secret: 'old-secret',
    });

    // Rotate secret
    await repo.update(sub.id, { secret: 'new-secret' });

    await webhookService.trigger('item.updated', { data: 'test' }, undefined, 'tenant-d');
    await new Promise((r) => setTimeout(r, 100));

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      'http://tenant-d.com/webhook',
      { data: 'test' },
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Signature': 'sha256=sig-for-new-secret'
        })
      })
    );
  });

  it('invalid URL: logs failure and does not crash', async () => {
    await repo.create({
      tenantId: 'tenant-invalid',
      eventType: 'event.invalid',
      url: 'http://localhost/invalid', // SSRF/invalid
      secret: 'sec',
    });

    await expect(webhookService.trigger('event.invalid', {}, undefined, 'tenant-invalid')).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('delivery after deletion: does not deliver if subscription is inactive or deleted', async () => {
    const sub = await repo.create({
      tenantId: 'tenant-deleted',
      eventType: 'event.deleted',
      url: 'http://tenant-deleted.com/webhook',
      secret: 'sec',
    });
    
    await repo.delete(sub.id);

    await webhookService.trigger('event.deleted', {}, undefined, 'tenant-deleted');
    await new Promise((r) => setTimeout(r, 100));

    expect(axios.post).not.toHaveBeenCalled();
  });
});
