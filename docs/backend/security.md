# Security Documentation

This document describes the security headers and origin controls implemented in the TalentTrust Backend.

## Overview

The application utilizes [Helmet](https://helmetjs.github.io/) to set various HTTP headers for security and [CORS](https://github.com/expressjs/cors) to manage cross-origin resource sharing.

## HTTP Response Policies (Helmet)

Helmet is configured to harden the application against common web vulnerabilities.

### Implemented Headers

- **Content-Security-Policy (CSP)**: Restricts where resources (scripts, styles, images) can be loaded from.
  - `default-src`: 'self'
  - `script-src`: 'self'
  - `style-src`: 'self', 'unsafe-inline'
  - `img-src`: 'self', data:, https:
  - `frame-src`: 'none' (Prevents clickjacking)
- **Strict-Transport-Security (HSTS)**: Ensures the browser only communicates over HTTPS for one year, including subdomains.
- **Referrer-Policy**: Set to `strict-origin-when-cross-origin`.
- **Cross-Origin-Resource-Policy**: Set to `same-origin`.

## Origin Controls (CORS)

Cross-Origin Resource Sharing is restricted to authorized origins to prevent unauthorized access from other domains.

### Configuration

- **Allowed Origins**: 
  - `http://localhost:3000` (Default Development)
  - `http://localhost:3001` (Default Development)
   - Configurable via `CORS_ALLOWED_ORIGINS` environment variable (comma-separated list).
   - **Production Restriction**: Wildcard origin (`*`) is strictly denied in production mode (`NODE_ENV=production`)
- **Allowed Methods**: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.
- **Allowed Headers**: `Content-Type`, `Authorization`.
- **Credentials**: Enabled (Allows sending cookies/authorization headers).
- **Max Age**: 86400 seconds (24 hours cache for preflight requests).

### Validation Rules

The CORS configuration is validated at application startup:

1. **Wildcard Denial in Production**: If `NODE_ENV=production` and the allowlist contains `*`, the application will fail to start with error: "Wildcard CORS origin (*) is not allowed in production mode"
2. **Deny-by-default in Production**: If `NODE_ENV=production` and `CORS_ALLOWED_ORIGINS` is not set, the allowlist is empty and all cross-origin requests are rejected.
3. **Origin Format Validation**: Origins that don't start with `http://` or `https://` will trigger a warning (except for wildcard `*`).

### Configuration Examples

**Development (default)**:
```bash
# Uses default localhost origins
NODE_ENV=development
```

**Development with custom origins**:
```bash
NODE_ENV=development
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:4200,http://127.0.0.1:3000
```

**Production**:
```bash
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://app.talenttrust.com,https://admin.talenttrust.com
```

**Invalid (will fail in production)**:
```bash
NODE_ENV=production
CORS_ALLOWED_ORIGINS=*  # ERROR: Wildcard not allowed in production
```

## Threat Scenarios Mitigated

| Threat | Mitigation Mechanism |
|--------|----------------------|
| **Cross-Site Scripting (XSS)** | CSP `script-src 'self'` prevents execution of unauthorized inline or external scripts. |
| **Clickjacking** | CSP `frame-src 'none'` prevents the site from being embedded in iframes. |
| **CSRF** | CORS origin validation ensures that requests come from trusted origins. |
| **Packet Sniffing** | HSTS forces the use of encrypted HTTPS connections. |
| **Information Leakage** | `Referrer-Policy` limits the amount of information sent in the `Referer` header. |

## Verification

Security policies are verified via:
1. **Unit Tests**: `src/config/security.test.ts` verifies configuration objects.
2. **Integration Tests**: `src/middleware/security.test.ts` verifies that headers are correctly applied to Express responses.

## SSRF Protection

The application implements Server-Side Request Forgery (SSRF) protection to prevent unauthorized access to internal/private resources.

### Protected Resources

The following are blocked by default:
- Private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Loopback addresses (127.0.0.0/8)
- Link-local addresses (169.254.0.0/16)
- IPv6 loopback (::1)
- IPv6 Unique Local Addresses (fc00::/7)
- IPv6 link-local addresses (fe80::/10)
- IPv4-mapped IPv6 addresses (dotted-quad and compressed-hex forms)
- Decimal/octal/hex encoded IP addresses

### Configuration

#### `SSRF_ALLOW_PRIVATE_HOSTS`

- **Default**: `false` (fail closed)
- **Allowed values**: `true`/`false` (or `1`/`0`)
- **Opt-in environments**: only when `NODE_ENV` is explicitly `development`, `test`, or `staging`
- **Behavior**:
  - **Production**: the flag is **rejected outright** at config load (`env.schema` superRefine). Runtime `isSafeUrl` also ignores it — private hosts are always blocked.
  - **development / test / staging**: if set to `true`, allows private hosts for local probes and fixtures.
  - **Unset or misspelled `NODE_ENV`**: treated as unknown — the bypass is ignored and private hosts are blocked (fail closed).

### Examples

**Production (strict)**:
```bash
NODE_ENV=production
# Do not set SSRF_ALLOW_PRIVATE_HOSTS — startup validation will fail if it is true
```

**Development with private hosts allowed**:
```bash
NODE_ENV=development
SSRF_ALLOW_PRIVATE_HOSTS=true
```

**Testing with private hosts allowed**:
```bash
NODE_ENV=test
SSRF_ALLOW_PRIVATE_HOSTS=true
```

### Security Notes

- **Fail Closed**: Unparseable URLs, empty hosts, and unknown/`unset` `NODE_ENV` values are always considered unsafe for the bypass path.
- **Production Hardening**: The bypass flag cannot be enabled in production (config validation fails) and cannot return `true` for a private host at runtime.
- **Single policy**: Env URL fields (`API_BASE_URL`, Horizon, Soroban, Stellar RPC) always call `isSafeUrl` — there is no separate schema short-circuit.
- **Test Coverage**: Comprehensive tests verify encoded IPs, IPv6, metadata endpoints, production flag rejection, and unknown-env fail-closed behavior.

Run tests using:
```bash
npm test
```
