# Webhooks Request & Delivery Lifecycle

This document traces how webhook subscription requests and outbound event deliveries move through `src/app.ts`, `src/events.ts`, and `src/webhooks.ts`.

For endpoint schemas, headers, and error codes, see [Webhooks API Reference](webhooks.md).

## 1. Subscription Management Flow

All management routes are mounted at `/api/v1/webhook-subscriptions` in `src/app.ts`.

```mermaid
sequenceDiagram
    participant Client
    participant App as Express App (src/app.ts)
    participant Auth as webhookAuth
    participant Manager as WebhookManager (src/webhooks.ts)
    participant DNS as dns.lookup

    Client->>App: POST /api/v1/webhook-subscriptions
    App->>App: noStore middleware (Cache-Control: no-store)
    App->>Auth: Check WEBHOOK_ADMIN_TOKEN & Bearer header
    alt WEBHOOK_ADMIN_TOKEN unset
        Auth-->>Client: 404 not_found (application/problem+json)
    else Invalid/missing Bearer token
        Auth-->>Client: 401 unauthorized (application/problem+json)
    else Authorized
        App->>Manager: webhooks.create(req.body)
        Manager->>Manager: parseFilter() & parseEvents()
        Manager->>DNS: validateWebhookUrl(url)
        alt Validation or SSRF check failed
            Manager-->>Client: 400 invalid_url / invalid_events / invalid_filter
        else Valid
            Manager->>Manager: Generate UUID + whsec_ secret, store in Map
            Manager-->>App: { subscription, secret }
            App-->>Client: 201 Created ({ ...subscription, secret })
        end
    end
```

### Key Stages

1. **Cache protection (`src/app.ts`)**: `noStore` sets `Cache-Control: no-store` and `Pragma: no-cache` on all `/api/v1/webhook-subscriptions` responses.
2. **Admin auth (`src/app.ts` + `src/webhooks.ts`)**: `webhookAuth` fails closed with `404` when `WEBHOOK_ADMIN_TOKEN` is unset, and validates `Authorization: Bearer <token>` using `isWebhookAdminTokenValid`.
3. **Validation (`src/webhooks.ts`)**: `parseFilter`, `parseEvents`, and `validateWebhookUrl` (scheme, credentials, IPv4/IPv6 private-range check, and DNS resolution check) run before mutating state.
4. **In-memory storage (`src/webhooks.ts`)**: Subscriptions are stored in `WebhookManager.subscriptions` (`Map<string, WebhookSubscription>`). The `secret` is stripped by `publicSubscription` on `GET`/`PATCH` and returned only on `POST /` and `POST /:id/rotate-secret`.

## 2. Event Emission & Delivery Flow

When a store mutation occurs, `EscrowStore` emits an `EscrowEvent` via `StoreEventEmitter` (`src/events.ts`). `WebhookManager` registers a listener in its constructor (`events.on((event) => { void this.dispatch(event); })`).

```mermaid
sequenceDiagram
    participant Store as EscrowStore
    participant Emitter as StoreEventEmitter (src/events.ts)
    participant Manager as WebhookManager (src/webhooks.ts)
    participant Target as Subscriber Endpoint

    Store->>Emitter: emit(eventType, data)
    Emitter->>Emitter: Clone data, append to 500-event ring buffer
    Emitter->>Manager: listener(event) [fire-and-forget]
    Manager->>Manager: eventMatches(subscription, event)
    loop Each matching active subscription (Promise.all)
        Manager->>Manager: Record WebhookDelivery (status: pending)
        loop Up to 6 attempts
            Manager->>Manager: validateWebhookUrl(subscription.url)
            Manager->>Manager: Sign `${timestamp}.${body}` with HMAC-SHA256
            Manager->>Target: POST (5000 ms timeout)
            alt 2xx response
                Target-->>Manager: 200 OK
                Manager->>Manager: status = success, trimHistory()
            else Permanent 4xx (not 408/425/429)
                Target-->>Manager: 4xx
                Manager->>Manager: Break loop, status = failed, trimHistory()
            else Retryable (408/425/429/5xx/timeout/network)
                Target-->>Manager: Error / status
                Manager->>Manager: Sleep (Retry-After or exp backoff + jitter, cap 30s)
            end
        end
    end
```

### Key Stages

1. **Isolation (`src/events.ts`)**: `StoreEventEmitter.emit` wraps listener calls in `try/catch` so webhook failures never roll back a store mutation.
2. **Filtering (`src/webhooks.ts`)**: `eventMatches` checks `subscription.active`, event type membership (or `"*"`), and optional `filter.contractIds` / `filter.parties` against `event.data.contract`.
3. **Delivery & retries (`src/webhooks.ts`)**: `deliver` re-validates the URL on each attempt, signs the JSON payload, sends a `POST` with a `5000` ms timeout, and retries transient failures up to `6` times with exponential backoff (`1000` ms base, `30000` ms cap, ±10% jitter) or `Retry-After` (capped at `30000` ms).
4. **History trimming (`src/webhooks.ts`)**: `trimHistory` caps total retained deliveries at `1000` (`maxHistory`), evicting the oldest entries from both `deliveries` and `deliveriesBySubscription`.

## Related Documentation

- [Webhooks API Reference](webhooks.md)
- [Webhooks API Examples](webhooks-examples.md)
- [Webhooks Operations Runbook](runbook-webhooks.md)
