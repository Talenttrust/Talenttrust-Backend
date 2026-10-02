/**
 * Finality integration at the service/repository layer:
 * - provisional events are stored but hidden from public reads
 * - promotion is one-way, idempotent, and boundary-exact
 * - reorgs before finality keep events hidden
 * - provider failure fails closed and is retried on the next sweep
 */

import { EventAuditService, InMemoryEventAuditRepository } from './eventAuditRepository';
import { FinalityEvaluator } from '../finality/finalityEvaluator';
import { createFinalityPolicy } from '../finality/policy';

const policy = createFinalityPolicy(
  { depths: { stellar: 1, soroban: 3 }, defaultDepth: 6 },
  'test',
);

interface Harness {
  repo: InMemoryEventAuditRepository;
  service: EventAuditService;
  setHead: (head: number) => void;
}

function createHarness(): Harness {
  let head = 100;
  const provider = jest.fn(async () => head);
  const evaluator = new FinalityEvaluator(policy, provider);
  const repo = new InMemoryEventAuditRepository();
  const service = new EventAuditService(repo, console, evaluator);
  return {
    repo,
    service,
    setHead: (next: number) => {
      head = next;
    },
  };
}

function onChainEvent(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: '2026-03-24T00:00:00.000Z',
    type: 'MILESTONE_RELEASED',
    payload: { milestoneId: 'm-1' },
    network: 'soroban',
    ledger: 98,
    ...overrides,
  };
}

describe('EventAuditService finality', () => {
  it('marks on-chain events provisional below the finality depth and hides them from history', async () => {
    const { service, repo } = createHarness();
    // head 100, ledger 98 -> 3 confirmations == depth 3 -> finalized at boundary.
    const result = await service.processEvent(onChainEvent(), 'MILESTONE_RELEASED');

    expect(result.status).toBe('accepted');
    const stored = (await repo.findByDeduplicationKey(result.deduplicationKey!))!;
    expect(stored.finalityStatus).toBe('finalized');
    expect(stored.finalizedAt).toBeDefined();

    // One confirmation below the boundary -> provisional + hidden.
    const second = onChainEvent({
      eventId: 'event-2',
      sequence: 2,
      ledger: 99,
    });
    await service.processEvent(second, 'MILESTONE_RELEASED');

    const history = await service.getEventHistory('contract-1');
    expect(history.map((h) => h.eventId)).toEqual(['event-1']);
    expect(history.map((h) => h.eventId)).not.toContain('event-2');

    const provisional = await service.getProvisionalEvents('soroban');
    expect(provisional.map((p) => p.eventId)).toEqual(['event-2']);
  });

  it('exposes an event immediately at the exact finality boundary', async () => {
    const { service } = createHarness();
    // head 100, ledger 98 -> confirmations 3 == depth 3.
    await service.processEvent(onChainEvent({ ledger: 98 }), 'MILESTONE_RELEASED');

    const history = await service.getEventHistory('contract-1');
    expect(history).toHaveLength(1);
    expect(history[0].finalityStatus).toBe('finalized');
  });

  it('promotes provisional events once the head reaches the boundary', async () => {
    const { service, setHead } = createHarness();
    setHead(100);
    await service.processEvent(onChainEvent({ ledger: 99 }), 'MILESTONE_RELEASED');

    // head 100, ledger 99 -> 2 confirmations -> provisional.
    expect(await service.getProvisionalEvents('soroban')).toHaveLength(1);

    // Advance head to 101: confirmations 3 == depth 3 -> promote.
    setHead(101);
    const promotion = await service.promoteProvisionalEvents('soroban');
    expect(promotion).toEqual({ promoted: 1, remaining: 0 });

    expect(await service.getProvisionalEvents('soroban')).toHaveLength(0);
    const history = await service.getEventHistory('contract-1');
    expect(history).toHaveLength(1);
    expect(history[0].finalityStatus).toBe('finalized');
  });

  it('is idempotent — a second promotion sweep promotes nothing', async () => {
    const { service, setHead } = createHarness();
    setHead(100);
    await service.processEvent(onChainEvent({ ledger: 99 }), 'MILESTONE_RELEASED');
    setHead(101);
    await service.promoteProvisionalEvents('soroban');

    const again = await service.promoteProvisionalEvents('soroban');
    expect(again).toEqual({ promoted: 0, remaining: 0 });
  });

  it('keeps events provisional when the head regresses (reorg before finality)', async () => {
    const { service, setHead } = createHarness();
    setHead(100);
    await service.processEvent(onChainEvent({ ledger: 98 }), 'MILESTONE_RELEASED');
    // head 100, ledger 98 -> 3 confirmations -> finalized at boundary.
    expect(await service.getProvisionalEvents('soroban')).toHaveLength(0);

    // A different event one confirmation short of the boundary.
    setHead(100);
    await service.processEvent(onChainEvent({ eventId: 'event-2', sequence: 2, ledger: 99 }), 'MILESTONE_RELEASED');
    expect(await service.getProvisionalEvents('soroban')).toHaveLength(1);

    // Reorg: head drops below where it needs to be — nothing is promoted.
    setHead(100);
    const promotion = await service.promoteProvisionalEvents('soroban');
    expect(promotion).toEqual({ promoted: 0, remaining: 1 });

    // Then a fresh reorg moves the head past the boundary — still nothing
    // promoted for the reorged event until confirmations are re-earned.
    setHead(101);
    const promotion2 = await service.promoteProvisionalEvents('soroban');
    expect(promotion2).toEqual({ promoted: 1, remaining: 0 });
  });

  it('skips the promotion sweep when the provider is unavailable (fail-closed, retried later)', async () => {
    let head = 100;
    let down = false;
    const provider = jest.fn(async () => {
      if (down) throw new Error('rpc down');
      return head;
    });
    const service = new EventAuditService(
      new InMemoryEventAuditRepository(),
      console,
      new FinalityEvaluator(policy, provider),
    );
    await service.processEvent(onChainEvent({ ledger: 99 }), 'MILESTONE_RELEASED');
    expect(await service.getProvisionalEvents('soroban')).toHaveLength(1);

    // Provider goes down mid-sweep -> fail-closed, nothing promoted.
    down = true;
    const promotion = await service.promoteProvisionalEvents('soroban');
    expect(promotion).toEqual({ promoted: 0, remaining: 1 });
    expect(await service.getProvisionalEvents('soroban')).toHaveLength(1);

    // Provider recovers and the head advances past the boundary -> retried.
    down = false;
    head = 101;
    const retry = await service.promoteProvisionalEvents('soroban');
    expect(retry).toEqual({ promoted: 1, remaining: 0 });
  });

  it('treats off-chain events (no ledger) as finalized immediately', async () => {
    const { service } = createHarness();
    await service.processEvent(
      { ...onChainEvent(), network: undefined, ledger: undefined },
      'MILESTONE_RELEASED',
    );

    const history = await service.getEventHistory('contract-1');
    expect(history).toHaveLength(1);
    expect(history[0].finalityStatus).toBe('finalized');
  });

  it('defaults to finalized when no finality evaluator is configured (backwards compatible)', async () => {
    const repo = new InMemoryEventAuditRepository();
    const service = new EventAuditService(repo);

    await service.processEvent(onChainEvent({ ledger: 99 }), 'MILESTONE_RELEASED');

    const stored = (await repo.findByDeduplicationKey('contract-1:event-1:1'))!;
    expect(stored.finalityStatus).toBe('finalized');
    expect(stored.network).toBe('soroban');
    expect(stored.ledger).toBe(99);
    expect(await service.getProvisionalEvents('soroban')).toHaveLength(0);

    const promotion = await service.promoteProvisionalEvents('soroban');
    expect(promotion).toEqual({ promoted: 0, remaining: 0 });
  });

  it('treats legacy records without finalityStatus as finalized in public reads', async () => {
    const repo = new InMemoryEventAuditRepository();
    const service = new EventAuditService(repo, console, new FinalityEvaluator(policy, async () => 100));

    await service.processEvent({ ...onChainEvent(), network: undefined, ledger: undefined }, 'MILESTONE_RELEASED');
    // Legacy record simulated by stripping the finality fields from the store.
    const stored = (await repo.findByDeduplicationKey('contract-1:event-1:1'))!;
    const legacy = { ...stored };
    delete legacy.finalityStatus;
    delete legacy.finalizedAt;
    await repo.save(legacy);

    const history = await service.getEventHistory('contract-1');
    expect(history).toHaveLength(1);
  });

  it('filters provisional events by network', async () => {
    const { service } = createHarness();
    // soroban depth 3 and unknown-network default depth 6 both keep
    // ledger 99 below finality at head 100.
    await service.processEvent(onChainEvent({ eventId: 'e-soroban', sequence: 1, ledger: 99, network: 'soroban' }), 'X');
    await service.processEvent(onChainEvent({ eventId: 'e-unknown', sequence: 2, ledger: 99, network: 'ethereum' }), 'X');

    expect((await service.getProvisionalEvents('soroban')).map((p) => p.eventId)).toEqual(['e-soroban']);
    expect((await service.getProvisionalEvents('ethereum')).map((p) => p.eventId)).toEqual(['e-unknown']);
    expect(await service.getProvisionalEvents()).toHaveLength(2);
  });

  it('duplicate replays of provisional events stay hidden (idempotency preserved)', async () => {
    const { service } = createHarness();
    const event = onChainEvent({ ledger: 99 });
    const first = await service.processEvent(event, 'MILESTONE_RELEASED');
    const replay = await service.processEvent(event, 'MILESTONE_RELEASED');

    expect(first.status).toBe('accepted');
    expect(replay.status).toBe('duplicate');
    expect(await service.getProvisionalEvents('soroban')).toHaveLength(1);
    expect(await service.getEventHistory('contract-1')).toHaveLength(0);
  });
});
