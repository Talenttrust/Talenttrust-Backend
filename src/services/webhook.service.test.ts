import { WebhookService } from './webhook.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('WebhookService Retry & DLQ', () => {
  let service: WebhookService;

  beforeEach(() => {
    service = new WebhookService();
    jest.useFakeTimers();
  });

  it('should move to DLQ after maximum retries', async () => {
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));

    const payload = { id: '123', url: 'http://test.com', event: 'contract.created', data: {}, retryCount: 0 };
    
    const promise = service.send(payload);

    // Fast-forward through all retries
    for (let i = 0; i < 6; i++) {
      jest.runAllTimers();
    }

    await promise;
    expect(service.getDLQ().length).toBe(1);
    expect(service.getDLQ()[0].id).toBe('123');
  });
});