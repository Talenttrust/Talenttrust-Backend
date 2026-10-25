import { Request, Response } from 'express';

export interface ContractEvent {
  seq: number;
  type: 'contract.created' | 'contract.updated';
  contractId: number;
  action: string;
  status: string;
  contract: unknown;
  parties: string[];
}

type Listener = (event: ContractEvent) => void;

const RING_SIZE = 1000;

export class EventBus {
  private seq = 0;
  private buffer: ContractEvent[] = [];
  private listeners = new Set<Listener>();

  emit(input: Omit<ContractEvent, 'seq'>): ContractEvent {
    const event: ContractEvent = { ...input, seq: ++this.seq };
    this.buffer.push(event);
    if (this.buffer.length > RING_SIZE) this.buffer.shift();
    for (const l of this.listeners) {
      try { l(event); } catch { /* ignore */ }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  // Returns events after `afterSeq` matching filter, or null if evicted
  replay(afterSeq: number, filter: (e: ContractEvent) => boolean): ContractEvent[] | null {
    if (this.buffer.length === 0) return [];
    const oldest = this.buffer[0].seq;
    if (afterSeq < oldest - 1) return null; // evicted
    return this.buffer.filter((e) => e.seq > afterSeq && filter(e));
  }
}

export interface StreamOptions {
  heartbeatMs: number;
  maxDurationMs: number;
  maxPerIp: number;
  maxGlobal: number;
}

export const defaultStreamOptions: StreamOptions = {
  heartbeatMs: Number(process.env.SSE_HEARTBEAT_MS) || 15000,
  maxDurationMs: Number(process.env.SSE_MAX_DURATION_MS) || 55000,
  maxPerIp: 5,
  maxGlobal: 500,
};

export class StreamLimits {
  private perIp = new Map<string, number>();
  private total = 0;

  constructor(private readonly opts: StreamOptions) {}

  tryAcquire(ip: string): 'ok' | 'rate' | 'global' {
    if (this.total >= this.opts.maxGlobal) return 'global';
    const current = this.perIp.get(ip) ?? 0;
    const next = current + 1;
    if (next > this.opts.maxPerIp) return 'rate';
    this.perIp.set(ip, next);
    this.total += 1;
    return 'ok';
  }

  release(ip: string): void {
    const cur = this.perIp.get(ip) ?? 0;
    if (cur <= 1) this.perIp.delete(ip);
    else this.perIp.set(ip, cur - 1);
    this.total = Math.max(0, this.total - 1);
  }

  count(): number {
    return this.total;
  }
}

export function writeEvent(res: Response, event: ContractEvent): void {
  const payload = {
    contractId: event.contractId,
    action: event.action,
    status: event.status,
    contract: event.contract,
  };
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function setupStreamHeaders(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 2000\n\n');
}

export function handleStream(
  req: Request,
  res: Response,
  bus: EventBus,
  limits: StreamLimits,
  opts: StreamOptions,
): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const acq = limits.tryAcquire(ip);
  if (acq === 'rate') {
    res.status(429).json({ error: 'too-many-streams', message: 'Max concurrent streams per IP exceeded' });
    return;
  }
  if (acq === 'global') {
    res.status(503).json({ error: 'stream-limit', message: 'Global stream limit reached' });
    return;
  }

  const contractFilter = typeof req.query.contractId === 'string' ? Number(req.query.contractId) : undefined;
  const partyFilter = typeof req.query.party === 'string' ? req.query.party : undefined;
  const matches = (e: ContractEvent): boolean => {
    if (contractFilter !== undefined && Number.isFinite(contractFilter) && e.contractId !== contractFilter) return false;
    if (partyFilter && !e.parties.includes(partyFilter)) return false;
    return true;
  };

  setupStreamHeaders(res);

  const lastId = req.headers['last-event-id'];
  if (typeof lastId === 'string' && lastId.length > 0) {
    const after = Number(lastId);
    if (Number.isFinite(after)) {
      const replayed = bus.replay(after, matches);
      if (replayed === null) {
        res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'evicted' })}\n\n`);
      } else {
        for (const ev of replayed) writeEvent(res, ev);
      }
    }
  }

  const unsubscribe = bus.subscribe((event) => {
    if (matches(event)) writeEvent(res, event);
  });

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, opts.heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    clearTimeout(maxTimer);
    unsubscribe();
    limits.release(ip);
    try { res.end(); } catch { /* ignore */ }
  };

  const maxTimer = setTimeout(() => {
    try { res.write('retry: 2000\n\n'); } catch { /* ignore */ }
    close();
  }, opts.maxDurationMs);
  if (typeof maxTimer.unref === 'function') maxTimer.unref();

  req.on('close', close);
  res.on('close', close);

import { randomUUID } from 'crypto';

export const WEBHOOK_EVENT_TYPES = [
  'contract.created',
  'contract.updated',
  'contract.funded',
  'milestone.released',
  'dispute.raised',
  'dispute.resolved',
  'contract.cancelled',
  'reputation.issued',
  'reputation.updated',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface EscrowEvent {
  id: string;
  eventId: string;
  eventType: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export type EventListener = (event: EscrowEvent) => void;

export class StoreEventEmitter {
  private readonly listeners = new Set<EventListener>();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(eventType: WebhookEventType, data: Record<string, unknown>, now = new Date()): EscrowEvent {
    const event: EscrowEvent = {
      id: randomUUID(),
      eventId: randomUUID(),
      eventType,
      timestamp: now.toISOString(),
      data: structuredClone(data),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Notification failures must never roll back a successful store mutation.
      }
    }
    return event;
  }
}