import { InMemoryWebhookDeliveryStore } from './webhook-delivery-store';

describe('InMemoryWebhookDeliveryStore', () => {
  it('accepts new event ids and marks later duplicates', () => {
    const store = new InMemoryWebhookDeliveryStore(60, () => 1_000);

    expect(store.reserve('evt-1')).toBe('accepted');
    expect(store.reserve('evt-1')).toBe('duplicate');

    store.markProcessed('evt-1');

    expect(store.reserve('evt-1')).toBe('duplicate');
    expect(store.size()).toBe(1);
  });

  it('releases failed reservations and expires old entries', () => {
    let now = 1_000;
    const store = new InMemoryWebhookDeliveryStore(1, () => now);

    expect(store.reserve('evt-1')).toBe('accepted');
    store.release('evt-1');
    expect(store.reserve('evt-1')).toBe('accepted');

    store.markProcessed('evt-1');
    now += 1_500;

    expect(store.size()).toBe(0);
    expect(store.reserve('evt-1')).toBe('accepted');
  });

  it('ignores markProcessed calls for unknown event ids', () => {
    const store = new InMemoryWebhookDeliveryStore(60);

    expect(() => store.markProcessed('missing')).not.toThrow();
    expect(store.size()).toBe(0);
  });
});
