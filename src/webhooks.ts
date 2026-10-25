import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { EscrowEvent, StoreEventEmitter, WebhookEventType, WEBHOOK_EVENT_TYPES } from './events';
import { HttpError } from './store';

export interface WebhookSubscriptionPublic {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WebhookSubscription extends WebhookSubscriptionPublic {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  statusCode?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HttpClientResponse {
  statusCode: number;
}

export type WebhookHttpClient = (url: URL, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpClientResponse>;

export interface WebhookManagerOptions {
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  httpClient?: WebhookHttpClient;
  maxHistory?: number;
  maxAttempts?: number;
}

const isPrivateIp = (address: string): boolean => {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('::ffff:') || normalized.startsWith('2001:db8');
};

export async function validateWebhookUrl(raw: string, production = process.env.NODE_ENV === 'production'): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_url', 'Webhook URL is invalid');
  }
  const localhostDev = !production && url.hostname.toLowerCase() === 'localhost';
  if (url.username || url.password || !['https:', ...(localhostDev ? ['http:'] : [])].includes(url.protocol)) {
    throw new HttpError(400, 'invalid_url', 'Webhook URL must use HTTPS');
  }
  if (isPrivateIp(url.hostname) || (!localhostDev && url.hostname.toLowerCase() === 'localhost')) {
    throw new HttpError(400, 'invalid_url', 'Webhook URL resolves to a private address');
  }
  if (!localhostDev) {
    let records;
    try {
      records = await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new HttpError(400, 'invalid_url', 'Webhook hostname could not be resolved');
    }
    if (!records.length || records.some((record) => isPrivateIp(record.address))) {
      throw new HttpError(400, 'invalid_url', 'Webhook URL resolves to a private address');
    }
  }
  return url;
}

const defaultHttpClient: WebhookHttpClient = (url, body, headers, timeoutMs) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
    url,
    { method: 'POST', headers, timeout: timeoutMs },
    (response) => {
      response.resume();
      response.once('end', () => resolve({ statusCode: response.statusCode ?? 0 }));
    },
  );
  request.once('timeout', () => request.destroy(new Error('delivery timeout')));
  request.once('error', reject);
  request.end(body);
});

const safeEqual = (left: Buffer, right: Buffer): boolean => {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b) && left.length === right.length;
};

export function verifyWebhookSignature(secret: string, headers: Record<string, string | string[] | undefined>, rawBody: string, toleranceSec = 300): boolean {
  const get = (name: string) => {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key ? headers[key] : undefined;
    return Array.isArray(value) ? value[0] : value;
  };
  const signature = get('x-signature');
  const timestampRaw = get('x-timestamp');
  const timestamp = Number(timestampRaw);
  if (!signature || !Number.isInteger(timestamp) || Math.abs(Date.now() - timestamp) > toleranceSec * 1000) return false;
  const received = signature.match(/^sha256=([0-9a-f]{64})$/i)?.[1];
  if (!received) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return safeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

export function isWebhookAdminTokenValid(configured: string | undefined, authorization: string | undefined): boolean {
  if (!configured || !authorization?.startsWith('Bearer ')) return false;
  const presented = authorization.slice('Bearer '.length);
  return safeEqual(createHash('sha256').update(presented).digest(), createHash('sha256').update(configured).digest());
}

const publicSubscription = (subscription: WebhookSubscription): WebhookSubscriptionPublic => {
  const { secret: _secret, ...safe } = subscription;
  return safe;
};

const eventMatches = (subscription: WebhookSubscription, event: EscrowEvent) => subscription.active && (subscription.events.includes('*') || subscription.events.includes(event.eventType));

export class WebhookManager {
  private readonly subscriptions = new Map<string, WebhookSubscription>();
  private readonly deliveries = new Map<string, WebhookDelivery>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly httpClient: WebhookHttpClient;
  private readonly maxHistory: number;
  private readonly maxAttempts: number;

  constructor(events: StoreEventEmitter, options: WebhookManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.httpClient = options.httpClient ?? defaultHttpClient;
    this.maxHistory = options.maxHistory ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 6;
    events.on((event) => { void this.dispatch(event); });
  }

  async create(input: { url?: unknown; events?: unknown; eventType?: unknown }): Promise<{ subscription: WebhookSubscriptionPublic; secret: string }> {
    const url = await validateWebhookUrl(String(input.url ?? ''));
    const events = this.parseEvents(input.events ?? input.eventType);
    const now = new Date(this.now()).toISOString();
    const subscription: WebhookSubscription = { id: randomUUID(), url: url.toString(), events, active: true, secret: `whsec_${randomBytes(32).toString('base64')}`, createdAt: now, updatedAt: now };
    this.subscriptions.set(subscription.id, subscription);
    return { subscription: publicSubscription(subscription), secret: subscription.secret };
  }

  list(): WebhookSubscriptionPublic[] { return [...this.subscriptions.values()].map(publicSubscription); }
  get(id: string): WebhookSubscriptionPublic { return publicSubscription(this.require(id)); }

  async update(id: string, input: { url?: unknown; events?: unknown; eventType?: unknown; active?: unknown }): Promise<WebhookSubscriptionPublic> {
    const subscription = this.require(id);
    if (input.url !== undefined) subscription.url = (await validateWebhookUrl(String(input.url))).toString();
    if (input.events !== undefined || input.eventType !== undefined) subscription.events = this.parseEvents(input.events ?? input.eventType);
    if (input.active !== undefined) {
      if (typeof input.active !== 'boolean') throw new HttpError(400, 'invalid_active', 'active must be boolean');
      subscription.active = input.active;
    }
    subscription.updatedAt = new Date(this.now()).toISOString();
    return publicSubscription(subscription);
  }

  remove(id: string): { id: string; deleted: true } { this.require(id); this.subscriptions.delete(id); return { id, deleted: true }; }

  rotateSecret(id: string): { subscription: WebhookSubscriptionPublic; secret: string } {
    const subscription = this.require(id);
    subscription.secret = `whsec_${randomBytes(32).toString('base64')}`;
    subscription.updatedAt = new Date(this.now()).toISOString();
    return { subscription: publicSubscription(subscription), secret: subscription.secret };
  }

  history(id: string): WebhookDelivery[] {
    this.require(id);
    return [...this.deliveries.values()].filter((delivery) => delivery.subscriptionId === id);
  }

  private require(id: string): WebhookSubscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new HttpError(404, 'webhook_not_found', 'Webhook subscription not found');
    return subscription;
  }

  private parseEvents(raw: unknown): string[] {
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    if (!values.length || values.some((value) => typeof value !== 'string' || (!WEBHOOK_EVENT_TYPES.includes(value as WebhookEventType) && value !== '*'))) {
      throw new HttpError(400, 'invalid_events', 'events must contain supported event types or *');
    }
    return [...new Set(values as string[])];
  }

  private async dispatch(event: EscrowEvent): Promise<void> {
    const matching = [...this.subscriptions.values()].filter((subscription) => eventMatches(subscription, event));
    await Promise.all(matching.map((subscription) => this.deliver(subscription, event)));
  }

  private async deliver(subscription: WebhookSubscription, event: EscrowEvent): Promise<void> {
    const delivery: WebhookDelivery = { id: randomUUID(), subscriptionId: subscription.id, eventId: event.eventId, eventType: event.eventType, status: 'pending', attempts: 0, createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString() };
    this.deliveries.set(delivery.id, delivery);
    while (delivery.attempts < this.maxAttempts) {
      delivery.attempts += 1;
      delivery.updatedAt = new Date(this.now()).toISOString();
      try {
        const url = await validateWebhookUrl(subscription.url);
        const body = JSON.stringify(event);
        const timestamp = this.now();
        const signature = createHmac('sha256', subscription.secret).update(`${timestamp}.${body}`).digest('hex');
        const response = await this.httpClient(url, body, { 'Content-Type': 'application/json', 'X-Signature': `sha256=${signature}`, 'X-Timestamp': String(timestamp), 'X-Event-Type': event.eventType, 'X-Event-ID': event.eventId, 'X-Delivery-ID': delivery.id }, 5000);
        delivery.statusCode = response.statusCode;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          delivery.status = 'success';
          this.trimHistory();
          return;
        }
        delivery.lastError = `HTTP ${response.statusCode}`;
        if (response.statusCode >= 400 && response.statusCode < 500) break;
      } catch (error) {
        delivery.lastError = error instanceof Error ? error.message : 'delivery failed';
      }
      if (delivery.attempts < this.maxAttempts) {
        const base = Math.min(30_000, 1_000 * 2 ** (delivery.attempts - 1));
        await this.sleep(Math.round(base * (1 + (this.random() * 2 - 1) * 0.1)));
      }
    }
    delivery.status = 'failed';
    this.trimHistory();
  }

  private trimHistory() {
    while (this.deliveries.size > this.maxHistory) this.deliveries.delete(this.deliveries.keys().next().value as string);
  }
}
