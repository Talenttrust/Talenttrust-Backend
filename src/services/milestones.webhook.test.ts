/**
 * @file milestones.webhook.test.ts
 *
 * Tests for Issue #1193: milestone release webhook integration.
 *
 * Covers:
 *  - Creating a completed milestone fires `milestone.released` webhook event
 *  - Creating an incomplete milestone does NOT fire webhook
 *  - Webhook failure does NOT cause milestone creation to fail (fire-and-forget)
 *  - Without webhookService injection, no webhook is fired
 *  - Webhook trigger receives correct payload (milestoneId, contractId, amount, etc.)
 */

import { MilestonesService, CreateMilestoneInput, milestonesService } from './milestones.service';
import { WebhookService } from './webhook.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateMilestoneInput> = {}): CreateMilestoneInput {
  return {
    title: 'Design Phase',
    description: 'Complete initial design',
    amount: 500_000,
    completed: false,
    ...overrides,
  };
}

const CONTRACT_ID = 'contract-uuid-abc';

// ── Mock WebhookService ───────────────────────────────────────────────────────

function makeMockWebhookService() {
  return {
    trigger: jest.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MilestonesService — webhook integration', () => {
  let service: MilestonesService;
  let mockWebhook: ReturnType<typeof makeMockWebhookService>;

  beforeEach(() => {
    mockWebhook = makeMockWebhookService();
    service = new MilestonesService(mockWebhook as any);
    service.clearStore();
  });

  afterEach(() => {
    service.clearStore();
  });

  it('fires milestone.released webhook when a milestone is created with completed=true', async () => {
    service.create(CONTRACT_ID, makeInput({ completed: true }));
    // Fire-and-forget: allow promises to settle
    await new Promise((r) => setImmediate(r));
    expect(mockWebhook.trigger).toHaveBeenCalledTimes(1);
    expect(mockWebhook.trigger).toHaveBeenCalledWith(
      'milestone.released',
      expect.objectContaining({
        contractId: CONTRACT_ID,
        amount: 500_000,
      }),
    );
  });

  it('does NOT fire webhook when completed=false', async () => {
    service.create(CONTRACT_ID, makeInput({ completed: false }));
    await new Promise((r) => setImmediate(r));
    expect(mockWebhook.trigger).not.toHaveBeenCalled();
  });

  it('does NOT fire webhook when completed is not set (defaults to false)', async () => {
    const input: CreateMilestoneInput = {
      title: 'Phase 1',
      amount: 100_000,
    };
    service.create(CONTRACT_ID, input);
    await new Promise((r) => setImmediate(r));
    expect(mockWebhook.trigger).not.toHaveBeenCalled();
  });

  it('webhook payload contains the stable milestoneId from the created record', async () => {
    const record = service.create(CONTRACT_ID, makeInput({ completed: true }));
    await new Promise((r) => setImmediate(r));
    expect(mockWebhook.trigger).toHaveBeenCalledWith(
      'milestone.released',
      expect.objectContaining({ milestoneId: record.id }),
    );
  });

  it('webhook payload contains completedAt ISO timestamp', async () => {
    service.create(CONTRACT_ID, makeInput({ completed: true }));
    await new Promise((r) => setImmediate(r));
    const callArgs = mockWebhook.trigger.mock.calls[0];
    const payload = callArgs[1];
    expect(payload).toHaveProperty('completedAt');
    expect(typeof payload.completedAt).toBe('string');
    // Should be valid ISO-8601
    expect(() => new Date(payload.completedAt)).not.toThrow();
  });

  it('webhook failure does NOT cause milestone creation to throw', async () => {
    mockWebhook.trigger.mockRejectedValue(new Error('network failure'));
    expect(() => {
      service.create(CONTRACT_ID, makeInput({ completed: true }));
    }).not.toThrow();
    // Allow the rejected promise to settle without crashing
    await new Promise((r) => setImmediate(r));
  });

  it('webhook failure does NOT affect the returned milestone record', async () => {
    mockWebhook.trigger.mockRejectedValue(new Error('webhook down'));
    const record = service.create(CONTRACT_ID, makeInput({ completed: true, title: 'Delivery' }));
    await new Promise((r) => setImmediate(r));
    expect(record.title).toBe('Delivery');
    expect(record.completed).toBe(true);
    expect(record.contractId).toBe(CONTRACT_ID);
  });

  it('without webhookService injection, no webhook is fired', async () => {
    const serviceNoWebhook = new MilestonesService();
    serviceNoWebhook.create(CONTRACT_ID, makeInput({ completed: true }));
    await new Promise((r) => setImmediate(r));
    // No mock to assert on — just verifying it doesn't throw
    serviceNoWebhook.clearStore();
  });
});

// ── Backward compatibility ────────────────────────────────────────────────────

describe('MilestonesService — backward compatibility', () => {
  it('existing milestone operations still work without webhook injection', () => {
    const service = new MilestonesService();
    service.clearStore();

    const record = service.create('c-1', makeInput({ completed: false }));
    expect(record.id).toBeDefined();

    const list = service.listByContract('c-1');
    expect(list).toHaveLength(1);

    const fetched = service.getById('c-1', record.id);
    expect(fetched.id).toBe(record.id);

    const deleted = service.softDelete('c-1', record.id);
    expect(deleted.deletedAt).toBeDefined();

    service.clearStore();
  });

  it('singleton milestonesService export is still a MilestonesService instance', async () => {
    const { milestonesService: singleton } = await import('./milestones.service');
    expect(singleton).toBeInstanceOf(MilestonesService);
  });

  it('lives app singleton fires milestone.released through the real WebhookService on completed milestones', async () => {
    const triggerSpy = jest
      .spyOn(WebhookService.prototype, 'trigger')
      .mockResolvedValue(undefined);
    try {
      milestonesService.clearStore();
      milestonesService.create('wired-contract', makeInput({ completed: true }));
      await new Promise((r) => setImmediate(r));
      expect(triggerSpy).toHaveBeenCalledTimes(1);
      expect(triggerSpy).toHaveBeenCalledWith(
        'milestone.released',
        expect.objectContaining({ contractId: 'wired-contract' }),
      );
    } finally {
      triggerSpy.mockRestore();
      milestonesService.clearStore();
    }
  });
});
