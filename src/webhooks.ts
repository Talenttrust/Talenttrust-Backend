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
  filter?: WebhookSubscriptionFilter;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  previousExpiresAt?: string;
}

export interface WebhookSubscriptionFilter {
  parties?: string[];
  contractIds?: number[];
  escrowId?: string[];
}

interface WebhookSubscription extends WebhookSubscriptionPublic {
  secret: string;
  previousSecret?: string;
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
  /** Set on manual redeliveries: the delivery whose payload was re-sent. */
  redeliveryOf?: string;
  nextAttemptAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDeliveryRecord extends WebhookDelivery {
  url: string;
  secret: string;
  previousSecret?: string;
  previousExpiresAt?: string;
  event: EscrowEvent;
}

export interface HttpClientResponse {
  statusCode: number;
  retryAfterMs?: number;
}

export type WebhookHttpClient = (url: URL, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpClientResponse>;

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
  maxHistory?: number;
  maxAttempts?: number;
  queueRetriesOnly?: boolean;
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
      // url.hostname keeps the brackets of an IPv6 literal, which dns.lookup does not accept.
      records = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
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
      response.once('end', () => {
        const raw = response.headers['retry-after'];
        const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
        const retryAfterMs = raw !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
        resolve({ statusCode: response.statusCode ?? 0, retryAfterMs });
      });
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

export function verifyWebhookSignature(
  secretOrBody: string,
  headers: Record<string, string | string[] | undefined>,
  bodyOrSecret: string,
  toleranceSec = 300,
): boolean {
  const check = (secret: string, body: string): boolean => {
    const get = (name: string) => {
      const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      const value = key ? headers[key] : undefined;
      return Array.isArray(value) ? value[0] : value;
    };
    const signature = get('x-signature');
    const timestampRaw = get('x-timestamp');
    const timestamp = Number(timestampRaw);
    if (!signature || !Number.isInteger(timestamp) || Math.abs(Date.now() - timestamp) > toleranceSec * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    const signatureParts = signature.split(',').map((s) => s.trim());
    for (const part of signatureParts) {
      const received = part.match(/^sha256=([0-9a-f]{64})$/i)?.[1];
      if (received) {
        const receivedBuffer = Buffer.from(received, 'hex');
        if (receivedBuffer.length === expectedBuffer.length && safeEqual(receivedBuffer, expectedBuffer)) {
          return true;
        }
      }
    }
    return false;
  };

  if (check(secretOrBody, bodyOrSecret)) return true;
  return check(bodyOrSecret, secretOrBody);
}

export function isWebhookAdminTokenValid(configured: string | undefined, authorization: string | undefined): boolean {
  if (!configured || !authorization?.startsWith('Bearer ')) return false;
  const presented = authorization.slice('Bearer '.length);
  return safeEqual(createHash('sha256').update(presented).digest(), createHash('sha256').update(configured).digest());
}

const publicSubscription = (subscription: WebhookSubscription): WebhookSubscriptionPublic => {
  const { secret: _secret, previousSecret: _prevSecret, ...safe } = subscription;
  return safe;
};

const eventMatches = (subscription: WebhookSubscription, event: EscrowEvent) => {
  if (!subscription.active || (!subscription.events.includes('*') && !subscription.events.includes(event.eventType))) return false;
  if (!subscription.filter) return true;

  if (event.eventType === 'chain.event') {
    if (subscription.filter.escrowId) {
      const data = event.data as Record<string, any>;
      const nested = data?.event?.data as Record<string, any> | undefined;
      const targetId = String(data?.escrowId ?? nested?.escrowId ?? '');
      if (!subscription.filter.escrowId.includes(targetId)) return false;
    }
    return true;
  }

  const contract = event.data.contract;
  if (!contract || typeof contract !== 'object') return false;
  const record = contract as Record<string, unknown>;
  if (subscription.filter.contractIds && !subscription.filter.contractIds.includes(record.id as number)) return false;
  if (subscription.filter.parties && !subscription.filter.parties.some((party) => party === record.client || party === record.freelancer)) return false;
  return true;
};

function buildSignatureHeader(
  secret: string,
  previousSecret: string | undefined,
  previousExpiresAt: string | undefined,
  timestamp: number,
  body: string,
  now: number,
): string {
  const currentSig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  if (
    previousSecret &&
    previousExpiresAt &&
    now < new Date(previousExpiresAt).getTime()
  ) {
    const prevSig = createHmac('sha256', previousSecret).update(`${timestamp}.${body}`).digest('hex');
    return `sha256=${currentSig},sha256=${prevSig}`;
  }
  return `sha256=${currentSig}`;
}

export class WebhookManager {
  private readonly subscriptions = new Map<string, WebhookSubscription>();
  private readonly deliveries = new Map<string, WebhookDeliveryRecord>();
  // Per-subscription deliveries in creation order, so history never scans other subscriptions.
  private readonly deliveriesBySubscription = new Map<string, WebhookDeliveryRecord[]>();
  // Serialized event body per delivery (kept out of the public record, trimmed with history).
  private readonly payloads = new Map<string, string>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly httpClient: WebhookHttpClient;
  private readonly maxHistory: number;
  private readonly maxAttempts: number;
  private readonly queueRetriesOnly: boolean;

  constructor(events: StoreEventEmitter, options: WebhookManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.httpClient = options.httpClient ?? defaultHttpClient;
    this.maxHistory = options.maxHistory ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.queueRetriesOnly = options.queueRetriesOnly ?? (options.sleep === undefined);
    events.on((event) => { void this.dispatch(event); });
  }

  async create(input: { url?: unknown; events?: unknown; eventType?: unknown; filter?: unknown }): Promise<{ subscription: WebhookSubscriptionPublic; secret: string }> {
    const filter = this.parseFilter(input.filter);
    const url = await validateWebhookUrl(String(input.url ?? ''));
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
    if (input.url !== undefined) subscription.url = (await validateWebhookUrl(String(input.url))).toString();
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

  rotateSecret(id: string, graceSeconds: number = 86400): { subscription: WebhookSubscriptionPublic; secret: string } {
    const subscription = this.require(id);
    if (typeof graceSeconds !== 'number' || !Number.isFinite(graceSeconds) || graceSeconds < 0) {
      throw new HttpError(400, 'invalid_grace_seconds', 'graceSeconds must be a non-negative number');
    }
    const clampedGrace = Math.min(graceSeconds, 604800);
    if (clampedGrace > 0) {
      subscription.previousSecret = subscription.secret;
      subscription.previousExpiresAt = new Date(this.now() + clampedGrace * 1000).toISOString();
    } else {
      delete subscription.previousSecret;
      delete subscription.previousExpiresAt;
    }
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
    const invalid = () => { throw new HttpError(400, 'invalid_filter', 'filter must contain parties, contractIds, and/or escrowId arrays with at most 50 entries each'); };
    if (typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== 'parties' && key !== 'contractIds' && key !== 'escrowId')) return invalid();
    const filter: WebhookSubscriptionFilter = {};
    if (value.parties !== undefined) {
      if (!Array.isArray(value.parties) || value.parties.length < 1 || value.parties.length > 50 || value.parties.some((party) => typeof party !== 'string' || !party.trim())) return invalid();
      filter.parties = [...new Set(value.parties as string[])];
    }
    if (value.contractIds !== undefined) {
      if (!Array.isArray(value.contractIds) || value.contractIds.length < 1 || value.contractIds.length > 50 || value.contractIds.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)) return invalid();
      filter.contractIds = [...new Set(value.contractIds as number[])];
    }
    if (value.escrowId !== undefined) {
      if (!Array.isArray(value.escrowId) || value.escrowId.length < 1 || value.escrowId.length > 50 || value.escrowId.some((id) => typeof id !== 'string' || !id.trim())) return invalid();
      filter.escrowId = [...new Set(value.escrowId as string[])];
    }
    if (!filter.parties && !filter.contractIds && !filter.escrowId) return invalid();
    return filter;
  }

  private async dispatch(event: EscrowEvent): Promise<void> {
    const matching = [...this.subscriptions.values()].filter((subscription) => eventMatches(subscription, event));
    await Promise.all(matching.map((subscription) => this.deliver(subscription, event)));
  }

  /**
   * Re-send the stored payload of a finished delivery as a new delivery with the same
   * `eventId` (and so the same `X-Event-ID`) but a fresh `X-Delivery-ID`.
   * 404 for an unknown subscription or delivery, 409 while the original is still pending.
   */
  redeliver(subscriptionId: string, deliveryId: string): WebhookDelivery {
    const subscription = this.require(subscriptionId);
    const original = this.deliveries.get(deliveryId);
    const body = this.payloads.get(deliveryId);
    if (!original || original.subscriptionId !== subscriptionId || body === undefined) {
      throw new HttpError(404, 'webhook_delivery_not_found', 'Webhook delivery not found');
    }
    if (original.status === 'pending') {
      throw new HttpError(409, 'delivery_pending', 'Webhook delivery is still pending');
    }
    const delivery = this.recordDelivery(subscription, original.eventId, original.eventType, body, original.id);
    void this.attempt(subscription, delivery, body);
    return { ...delivery };
  }

  private async deliver(subscription: WebhookSubscription, event: EscrowEvent): Promise<void> {
    const delivery: WebhookDeliveryRecord = {
      id: randomUUID(),
      subscriptionId: subscription.id,
      eventId: event.eventId,
      eventType: event.eventType,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      url: subscription.url,
      secret: subscription.secret,
      previousSecret: subscription.previousSecret,
      previousExpiresAt: subscription.previousExpiresAt,
      event,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const body = JSON.stringify(event);
    const delivery = this.recordDelivery(subscription, event.eventId, event.eventType, body);
    await this.attempt(subscription, delivery, body);
  }

  private recordDelivery(subscription: WebhookSubscription, eventId: string, eventType: string, body: string, redeliveryOf?: string): WebhookDelivery {
    const now = new Date(this.now()).toISOString();
    const delivery: WebhookDelivery = { id: randomUUID(), subscriptionId: subscription.id, eventId, eventType, status: 'pending', attempts: 0, ...(redeliveryOf ? { redeliveryOf } : {}), createdAt: now, updatedAt: now };
    this.deliveries.set(delivery.id, delivery);
    this.payloads.set(delivery.id, body);
    const perSubscription = this.deliveriesBySubscription.get(subscription.id);
    if (perSubscription) perSubscription.push(delivery);
    else this.deliveriesBySubscription.set(subscription.id, [delivery]);
    return delivery;
  }

  private async attempt(subscription: WebhookSubscription, delivery: WebhookDelivery, body: string): Promise<void> {

    while (delivery.attempts < this.maxAttempts) {
      delivery.attempts += 1;
      delivery.updatedAt = new Date(this.now()).toISOString();
      let retryAfterMs: number | undefined;
      try {
        const url = await validateWebhookUrl(delivery.url);
        const timestamp = this.now();
        const signatureHeader = buildSignatureHeader(
          delivery.secret,
          delivery.previousSecret,
          delivery.previousExpiresAt,
          timestamp,
          body,
          this.now(),
        );

        const response = await this.httpClient(
          url,
          body,
          {
            'Content-Type': 'application/json',
            'X-Signature': signatureHeader,
            'X-Timestamp': String(timestamp),
            'X-Event-Type': event.eventType,
            'X-Event-ID': event.eventId,
            'X-Delivery-ID': delivery.id,
          },
          5000,
        );
        const response = await this.httpClient(url, body, { 'Content-Type': 'application/json', 'X-Signature': `sha256=${signature}`, 'X-Timestamp': String(timestamp), 'X-Event-Type': delivery.eventType, 'X-Event-ID': delivery.eventId, 'X-Delivery-ID': delivery.id }, 5000);
        delivery.statusCode = response.statusCode;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          delivery.status = 'success';
          delivery.nextAttemptAt = null;
          this.trimHistory();
          return;
        }
        delivery.lastError = `HTTP ${response.statusCode}`;
        const retryable = response.statusCode === 408 || response.statusCode === 425 || response.statusCode === 429;
        if (response.statusCode >= 400 && response.statusCode < 500 && !retryable) {
          delivery.status = 'failed';
          delivery.nextAttemptAt = null;
          break;
        }
        retryAfterMs = response.retryAfterMs;
      } catch (error) {
        delivery.lastError = error instanceof Error ? error.message : 'delivery failed';
      }

      if (delivery.attempts < this.maxAttempts) {
        const base = Math.min(30_000, 1_000 * 2 ** (delivery.attempts - 1));
        const backoff = Math.round(base * (1 + (this.random() * 2 - 1) * 0.1));
        const delay = retryAfterMs !== undefined ? Math.min(30_000, retryAfterMs) : backoff;
        delivery.nextAttemptAt = new Date(this.now() + delay).toISOString();

        if (this.queueRetriesOnly) {
          return;
        }
        await this.sleep(delay);
      }
    }
    delivery.status = 'failed';
    delivery.nextAttemptAt = null;
    this.trimHistory();
  }

  async processDue(now?: number): Promise<{ processed: number; succeeded: number; failed: number }> {
    const currentNow = now ?? this.now();
    const dueDeliveries: WebhookDeliveryRecord[] = [];

    for (const delivery of this.deliveries.values()) {
      if (
        delivery.status === 'pending' &&
        delivery.nextAttemptAt &&
        new Date(delivery.nextAttemptAt).getTime() <= currentNow
      ) {
        dueDeliveries.push(delivery);
      }
    }

    let succeeded = 0;
    let failed = 0;

    for (const record of dueDeliveries) {
      record.attempts += 1;
      record.updatedAt = new Date(this.now()).toISOString();
      let retryAfterMs: number | undefined;

      try {
        const url = await validateWebhookUrl(record.url);
        const body = JSON.stringify(record.event);
        const timestamp = this.now();
        const signatureHeader = buildSignatureHeader(
          record.secret,
          record.previousSecret,
          record.previousExpiresAt,
          timestamp,
          body,
          this.now(),
        );

        const response = await this.httpClient(
          url,
          body,
          {
            'Content-Type': 'application/json',
            'X-Signature': signatureHeader,
            'X-Timestamp': String(timestamp),
            'X-Event-Type': record.event.eventType,
            'X-Event-ID': record.event.eventId,
            'X-Delivery-ID': record.id,
          },
          5000,
        );

        record.statusCode = response.statusCode;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          record.status = 'success';
          record.nextAttemptAt = null;
          succeeded += 1;
          continue;
        }

        record.lastError = `HTTP ${response.statusCode}`;
        const retryable = response.statusCode === 408 || response.statusCode === 425 || response.statusCode === 429;
        if (response.statusCode >= 400 && response.statusCode < 500 && !retryable) {
          record.status = 'failed';
          record.nextAttemptAt = null;
          failed += 1;
          continue;
        }
        retryAfterMs = response.retryAfterMs;
      } catch (error) {
        record.lastError = error instanceof Error ? error.message : 'delivery failed';
      }

      if (record.attempts < this.maxAttempts) {
        const base = Math.min(30_000, 1_000 * 2 ** (record.attempts - 1));
        const backoff = Math.round(base * (1 + (this.random() * 2 - 1) * 0.1));
        const delay = retryAfterMs !== undefined ? Math.min(30_000, retryAfterMs) : backoff;
        record.nextAttemptAt = new Date(this.now() + delay).toISOString();
      } else {
        record.status = 'failed';
        record.nextAttemptAt = null;
        failed += 1;
      }
    }

    this.trimHistory();
    return { processed: dueDeliveries.length, succeeded, failed };
  }

  startRetryRunner(intervalMs: number): { stop: () => void } {
    if (intervalMs <= 0) return { stop: () => {} };
    const timer = setInterval(() => {
      void this.processDue();
    }, intervalMs);
    timer.unref();
    return {
      stop: () => clearInterval(timer),
    };
  }

  private trimHistory() {
    while (this.deliveries.size > this.maxHistory) {
      const oldestId = this.deliveries.keys().next().value as string;
      const oldest = this.deliveries.get(oldestId);
      this.deliveries.delete(oldestId);
      this.payloads.delete(oldestId);
      if (!oldest) continue;
      const perSubscription = this.deliveriesBySubscription.get(oldest.subscriptionId);
      if (!perSubscription) continue;
      const index = perSubscription.findIndex((delivery) => delivery.id === oldestId);
      if (index >= 0) perSubscription.splice(index, 1);
      if (!perSubscription.length) this.deliveriesBySubscription.delete(oldest.subscriptionId);
    }
  }
}
