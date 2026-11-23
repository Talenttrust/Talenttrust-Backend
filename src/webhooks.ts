import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { lookup } from 'dns/promises';
import type { LookupFunction } from 'net';
import { isIP } from 'net';
import { EscrowEvent, StoreEventEmitter, WebhookEventType, WEBHOOK_EVENT_TYPES } from './events';
import { HttpError } from './store';

export interface WebhookSubscriptionPublic {
  id: string;
  url: string;
  events: string[];
  filter?: WebhookSubscriptionFilter;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscriptionFilter {
  parties?: string[];
  contractIds?: number[];
}

interface WebhookSubscription extends WebhookSubscriptionPublic {
  secret: string;
}

export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed';

export const WEBHOOK_DELIVERY_STATUSES: readonly WebhookDeliveryStatus[] = ['pending', 'success', 'failed'];

export const DEFAULT_WEBHOOK_HISTORY_LIMIT = 50;
export const MAX_WEBHOOK_HISTORY_LIMIT = 100;

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  statusCode?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HttpClientResponse {
  statusCode: number;
  retryAfterMs?: number;
}

export type WebhookHttpClient = (url: ValidatedWebhookUrl, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpClientResponse>;

export type ValidatedWebhookUrl = URL & { addresses: string[] };
export type WebhookResolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

export interface WebhookHistoryOptions {
  /** Maximum number of newest deliveries to return (defaults to 50). */
  limit?: number;
  /** Only return deliveries in this status. */
  status?: WebhookDeliveryStatus;
}

export interface WebhookManagerOptions {
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  httpClient?: WebhookHttpClient;
  resolver?: WebhookResolver;
  maxHistory?: number;
  maxAttempts?: number;
}

/** Parses an IPv4 literal into its octets, or null when it is not a dotted-quad. */
const ipv4Octets = (address: string): number[] | null => (isIP(address) === 4 ? address.split('.').map(Number) : null);

/**
 * Parses an IPv6 literal (`::` compression, expanded form, zone id and embedded IPv4 included)
 * into its 16 bytes, or null when it is not a valid IPv6 literal.
 */
const ipv6Bytes = (input: string): number[] | null => {
  let address = input.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (!address.includes(':')) return null;
  // Rewrite an embedded IPv4 tail (e.g. ::ffff:192.168.0.1) as two hexadecimal groups.
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (embedded) {
    const octets = embedded[2].split('.').map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    address = `${embedded[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const groups = [...head, ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - groups.length;
  // Without `::` the address must be exactly eight groups; with it, at most eight.
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  return [...head, ...Array<string>(missing).fill('0'), ...tail].flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
};

/** Unspecified, loopback, private, shared, documentation, benchmarking, multicast and reserved IPv4 ranges. */
const isPrivateIpv4 = (octets: number[]): boolean => {
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved and 255.255.255.255 broadcast
};

/** Unspecified, loopback, ULA, link-local, site-local, documentation, multicast, NAT64 and mapped IPv4 ranges. */
const isPrivateIpv6 = (bytes: number[]): boolean => {
  const startsWith = (prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  // IPv4-mapped and IPv4-compatible forms inherit the classification of the embedded address.
  if (mapped || compatible) return isPrivateIpv4(bytes.slice(12));
  return bytes.every((byte) => byte === 0)
    || (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1)
    || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) // fe80::/10 link-local
    || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) // fec0::/10 site-local
    || (bytes[0] & 0xfe) === 0xfc // fc00::/7 unique local
    || bytes[0] === 0xff // ff00::/8 multicast
    || startsWith([0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]) // 64:ff9b::/96 NAT64
    || startsWith([0x20, 0x01, 0x0d, 0xb8]); // 2001:db8::/32 documentation
};

const isPrivateIp = (address: string): boolean => {
  const octets = ipv4Octets(address);
  if (octets) return isPrivateIpv4(octets);
  const bytes = ipv6Bytes(address);
  return bytes ? isPrivateIpv6(bytes) : false;
};

export async function validateWebhookUrl(
  raw: string,
  production = process.env.NODE_ENV === 'production',
  resolver: WebhookResolver = lookup,
): Promise<ValidatedWebhookUrl> {
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
  let addresses: string[];
  if (localhostDev) {
    addresses = ['127.0.0.1', '::1'];
  } else if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    addresses = [url.hostname.replace(/^\[|\]$/g, '')];
  } else {
    let records;
    try {
      // url.hostname keeps the brackets of an IPv6 literal, which dns.lookup does not accept.
      records = await resolver(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
    } catch {
      throw new HttpError(400, 'invalid_url', 'Webhook hostname could not be resolved');
    }
    if (!records.length || records.some((record) => isPrivateIp(record.address))) {
      throw new HttpError(400, 'invalid_url', 'Webhook URL resolves to a private address');
    }
    addresses = records.map((record) => record.address);
  }
  return Object.assign(url, { addresses });
}

export const defaultHttpClient: WebhookHttpClient = (url, body, headers, timeoutMs) => new Promise((resolve, reject) => {
  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    void hostname;
    const records = url.addresses.map((address) => ({ address, family: isIP(address) }));
    const wantsAll = typeof options === 'object' && options.all === true;
    if (wantsAll) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
    url,
    {
      method: 'POST',
      headers,
      timeout: timeoutMs,
      lookup: pinnedLookup,
    },
    (response) => {
      let bytesRead = 0;
      const maxResponseBytes = 1024 * 1024;
      response.on('data', (chunk: Buffer) => {
        bytesRead += chunk.length;
        if (bytesRead > maxResponseBytes) response.destroy(new Error('delivery response body too large'));
      });
      response.once('end', () => {
        const raw = response.headers['retry-after'];
        const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
        const retryAfterMs = raw !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
        resolve({ statusCode: response.statusCode ?? 0, retryAfterMs });
      });
      response.once('error', reject);
      response.resume();
    },
  );
  request.once('timeout', () => request.destroy(new Error('delivery timeout')));
  request.once('error', reject);
  const absoluteTimeout = setTimeout(() => request.destroy(new Error('delivery timeout')), timeoutMs);
  request.once('close', () => clearTimeout(absoluteTimeout));
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

const eventMatches = (subscription: WebhookSubscription, event: EscrowEvent) => {
  if (!subscription.active || (!subscription.events.includes('*') && !subscription.events.includes(event.eventType))) return false;
  if (!subscription.filter) return true;
  const contract = event.data.contract;
  if (!contract || typeof contract !== 'object') return false;
  const record = contract as Record<string, unknown>;
  if (subscription.filter.contractIds && !subscription.filter.contractIds.includes(record.id as number)) return false;
  if (subscription.filter.parties && !subscription.filter.parties.some((party) => party === record.client || party === record.freelancer)) return false;
  return true;
};

export class WebhookManager {
  private readonly subscriptions = new Map<string, WebhookSubscription>();
  private readonly deliveries = new Map<string, WebhookDelivery>();
  // Per-subscription deliveries in creation order, so history never scans other subscriptions.
  private readonly deliveriesBySubscription = new Map<string, WebhookDelivery[]>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly httpClient: WebhookHttpClient;
  private readonly resolver: WebhookResolver;
  private readonly maxHistory: number;
  private readonly maxAttempts: number;

  constructor(events: StoreEventEmitter, options: WebhookManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.httpClient = options.httpClient ?? defaultHttpClient;
    this.resolver = options.resolver ?? lookup;
    this.maxHistory = options.maxHistory ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 6;
    events.on((event) => { void this.dispatch(event); });
  }

  async create(input: { url?: unknown; events?: unknown; eventType?: unknown; filter?: unknown }): Promise<{ subscription: WebhookSubscriptionPublic; secret: string }> {
    const filter = this.parseFilter(input.filter);
    const url = await validateWebhookUrl(String(input.url ?? ''), undefined, this.resolver);
    const events = this.parseEvents(input.events ?? input.eventType);
    const now = new Date(this.now()).toISOString();
    const subscription: WebhookSubscription = { id: randomUUID(), url: url.toString(), events, ...(filter ? { filter } : {}), active: true, secret: `whsec_${randomBytes(32).toString('base64')}`, createdAt: now, updatedAt: now };
    this.subscriptions.set(subscription.id, subscription);
    return { subscription: publicSubscription(subscription), secret: subscription.secret };
  }

  list(): WebhookSubscriptionPublic[] { return [...this.subscriptions.values()].map(publicSubscription); }
  get(id: string): WebhookSubscriptionPublic { return publicSubscription(this.require(id)); }

  async update(id: string, input: { url?: unknown; events?: unknown; eventType?: unknown; active?: unknown; filter?: unknown }): Promise<WebhookSubscriptionPublic> {
    const subscription = this.require(id);
    const filter = input.filter === undefined ? undefined : this.parseFilter(input.filter);
    if (input.url !== undefined) subscription.url = (await validateWebhookUrl(String(input.url), undefined, this.resolver)).toString();
    if (input.events !== undefined || input.eventType !== undefined) subscription.events = this.parseEvents(input.events ?? input.eventType);
    if (input.filter !== undefined) {
      if (filter) subscription.filter = filter;
      else delete subscription.filter;
    }
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

  history(id: string, options: WebhookHistoryOptions = {}): WebhookDelivery[] {
    this.require(id);
    const limit = options.limit ?? DEFAULT_WEBHOOK_HISTORY_LIMIT;
    const deliveries = this.deliveriesBySubscription.get(id) ?? [];
    const history: WebhookDelivery[] = [];
    // Walk newest-first, filtering by status before counting against the limit.
    for (let i = deliveries.length - 1; i >= 0 && history.length < limit; i -= 1) {
      const delivery = deliveries[i];
      if (options.status && delivery.status !== options.status) continue;
      history.push(delivery);
    }
    return history;
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

  private parseFilter(raw: unknown): WebhookSubscriptionFilter | undefined {
    if (raw === undefined || raw === null) return undefined;
    const invalid = () => { throw new HttpError(400, 'invalid_filter', 'filter must contain parties and/or contractIds arrays with at most 50 entries each'); };
    if (typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== 'parties' && key !== 'contractIds')) return invalid();
    const filter: WebhookSubscriptionFilter = {};
    if (value.parties !== undefined) {
      if (!Array.isArray(value.parties) || value.parties.length < 1 || value.parties.length > 50 || value.parties.some((party) => typeof party !== 'string' || !party.trim())) return invalid();
      filter.parties = [...new Set(value.parties as string[])];
    }
    if (value.contractIds !== undefined) {
      if (!Array.isArray(value.contractIds) || value.contractIds.length < 1 || value.contractIds.length > 50 || value.contractIds.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)) return invalid();
      filter.contractIds = [...new Set(value.contractIds as number[])];
    }
    if (!filter.parties && !filter.contractIds) return invalid();
    return filter;
  }

  private async dispatch(event: EscrowEvent): Promise<void> {
    const matching = [...this.subscriptions.values()].filter((subscription) => eventMatches(subscription, event));
    await Promise.all(matching.map((subscription) => this.deliver(subscription, event)));
  }

  private async deliver(subscription: WebhookSubscription, event: EscrowEvent): Promise<void> {
    const delivery: WebhookDelivery = { id: randomUUID(), subscriptionId: subscription.id, eventId: event.eventId, eventType: event.eventType, status: 'pending', attempts: 0, createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString() };
    this.deliveries.set(delivery.id, delivery);
    const perSubscription = this.deliveriesBySubscription.get(subscription.id);
    if (perSubscription) perSubscription.push(delivery);
    else this.deliveriesBySubscription.set(subscription.id, [delivery]);
    while (delivery.attempts < this.maxAttempts) {
      delivery.attempts += 1;
      delivery.updatedAt = new Date(this.now()).toISOString();
      let retryAfterMs: number | undefined;
      try {
        const url = await validateWebhookUrl(subscription.url, undefined, this.resolver);
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
        const retryable = response.statusCode === 408 || response.statusCode === 425 || response.statusCode === 429;
        if (response.statusCode >= 400 && response.statusCode < 500 && !retryable) break;
        retryAfterMs = response.retryAfterMs;
      } catch (error) {
        delivery.lastError = error instanceof Error ? error.message : 'delivery failed';
      }
      if (delivery.attempts < this.maxAttempts) {
        const base = Math.min(30_000, 1_000 * 2 ** (delivery.attempts - 1));
        const backoff = Math.round(base * (1 + (this.random() * 2 - 1) * 0.1));
        await this.sleep(retryAfterMs !== undefined ? Math.min(30_000, retryAfterMs) : backoff);
      }
    }
    delivery.status = 'failed';
    this.trimHistory();
  }

  private trimHistory() {
    while (this.deliveries.size > this.maxHistory) {
      const oldestId = this.deliveries.keys().next().value as string;
      const oldest = this.deliveries.get(oldestId);
      this.deliveries.delete(oldestId);
      if (!oldest) continue;
      const perSubscription = this.deliveriesBySubscription.get(oldest.subscriptionId);
      if (!perSubscription) continue;
      const index = perSubscription.findIndex((delivery) => delivery.id === oldestId);
      if (index >= 0) perSubscription.splice(index, 1);
      if (!perSubscription.length) this.deliveriesBySubscription.delete(oldest.subscriptionId);
    }
  }
}
