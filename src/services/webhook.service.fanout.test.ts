import { WebhookService } from './webhook.service';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';
import { getDb, closeDb } from '../db/database';
import axios from 'axios';
import * as ssrf from '../utils/ssrf';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../utils/ssrf');
const mockedIsSafeUrl = ssrf.isSafeUrl as jest.MockedFunction<typeof ssrf.isSafeUrl>;

describe('WebhookService Fan-Out Triggering', () => {
  let service: WebhookService;
  let repo: SqliteWebhookSubscriptionRepository;

  beforeAll(() => {
    process.env.DB_PATH = ':memory:';
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedIsSafeUrl.mockImplementation(() => true);
    // Reinitialize DB
    closeDb();
    const db = getDb();
    repo = new SqliteWebhookSubscriptionRepository(db);
    service = new WebhookService();

    // Clear subscriptions table
    db.prepare('DELETE FROM webhook_subscriptions').run();
  });

  afterAll(() => {
    closeDb();
  });

  it('delivers events to all active subscriptions matching the eventType', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    // 1. Create two subscriptions for the eventType
    await repo.create({
      url: 'https://consumer1.com/hooks',
      eventType: 'contract.created',
      secret: 'secret-1',
    });

    await repo.create({
      url: 'https://consumer2.com/hooks',
      eventType: 'contract.created',
      secret: 'secret-2',
    });

    // 2. Create one inactive subscription or matching another eventType
    await repo.create({
      url: 'https://consumer3.com/hooks',
      eventType: 'contract.updated',
    });

    const allSubs = await repo.findAll();
    console.log("TEST ALL SUBS IN DB:", allSubs.length, allSubs);

    // 3. Trigger contract.created event
    const eventData = { contractId: '123-uuid', amount: 5000 };
    try {
      await service.trigger('contract.created', eventData, 'correlation-id-abc');
    } catch (e: any) {
      console.error("TRIGGER EXCEPTION:", e);
    }

    // 4. Verify axios called twice for both active subscriptions of contract.created
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      1,
      'https://consumer1.com/hooks',
      eventData,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Correlation-Id': 'correlation-id-abc',
        }),
      })
    );
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      2,
      'https://consumer2.com/hooks',
      eventData,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Correlation-Id': 'correlation-id-abc',
        }),
      })
    );
  });
});
