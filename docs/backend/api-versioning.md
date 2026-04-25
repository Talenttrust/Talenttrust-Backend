# API Versioning

## Overview

TalentTrust Backend uses URL-path versioning. All API routes are prefixed with
`/api/<version>/`, e.g. `/api/v2/contracts`.

## Supported Versions

| Version | Status     | Sunset Date          |
|---------|------------|----------------------|
| v2      | ✅ Current  | —                    |
| v1      | ⚠️ Deprecated | 2026-11-01          |

## Deprecation Headers

When a client calls a deprecated version, the server adds the following
response headers on **every** response:

| Header        | Value                                      | Purpose                                      |
|---------------|--------------------------------------------|----------------------------------------------|
| `Deprecation` | RFC 7231 date (e.g. `Sat, 01 Nov 2026 00:00:00 GMT`) | Signals the version is deprecated |
| `Sunset`      | Same RFC 7231 date                         | Hard removal date                            |
| `Link`        | `<upgrade-guide-url>; rel="successor-version"` | Points to the migration guide            |
| `X-API-Version` | e.g. `v1`                               | Always present; confirms which version served the request |

These headers follow [RFC 8594 (Sunset)](https://www.rfc-editor.org/rfc/rfc8594)
and the [Deprecation HTTP Header draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-deprecation-header).

## Error Responses

| Scenario                  | Status | Body                                                    |
|---------------------------|--------|---------------------------------------------------------|
| Unknown version           | 404    | `{ error: "Not Found", currentVersion: "v2" }`         |
| Removed (unsupported) version | 410 | `{ error: "Gone", currentVersion: "v2", upgradeGuide: "..." }` |
| Malformed version segment | 400    | `{ error: "Bad Request", message: "..." }`              |

## Migrating from v1 to v2

Full migration guide: <https://docs.talenttrust.io/api/migration/v1-to-v2>

### Quick steps

1. Update your base URL from `/api/v1/` to `/api/v2/`.
2. Check the `Link` response header on any v1 call for the exact guide URL.
3. Review breaking changes in the changelog below.
4. Test against the v2 endpoints in staging before switching production traffic.

### Breaking changes (v1 → v2)

- No breaking changes yet. v1 and v2 currently share the same route handlers.
  This section will be updated as v2-specific behaviour is introduced.

## Adding a New Version

1. Add an entry to `src/versioning/index.ts`:

```ts
v3: {
  supported: true,
  deprecated: false,
},
```

2. Mount the middleware and router in `src/app.ts`:

```ts
app.use('/api/v3', apiVersionMiddleware('v3'));
app.use('/api/v3/contracts', contractsV3Router);
```

3. When deprecating an old version, set `deprecated: true` and add a
   `sunsetDate` (minimum 6 months notice) and `upgradeGuide` URL.

4. When removing a version, set `supported: false`. The middleware will
   automatically return `410 Gone` for all requests to that prefix.

## Implementation

- Middleware: `src/middleware/apiVersion.ts`
- Version registry: `src/versioning/index.ts`
- Tests: `src/middleware/apiVersion.test.ts`
