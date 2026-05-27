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
  - Configurable via `ALLOWED_ORIGINS` environment variable (comma-separated list).
  - **Production Restriction**: Wildcard origin (`*`) is strictly denied in production mode (`NODE_ENV=production`)
- **Allowed Methods**: `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`, `PATCH`.
- **Allowed Headers**: `Content-Type`, `Authorization`.
- **Credentials**: Enabled (Allows sending cookies/authorization headers).
- **Max Age**: 86400 seconds (24 hours cache for preflight requests).

### Validation Rules

The CORS configuration is validated at application startup:

1. **Wildcard Denial in Production**: If `NODE_ENV=production` and the allowlist contains `*`, the application will fail to start with error: "Wildcard CORS origin (*) is not allowed in production mode"
2. **Empty Allowlist Prevention**: The allowlist cannot be empty. If no origins are configured, defaults to localhost origins.
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
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:4200,http://127.0.0.1:3000
```

**Production**:
```bash
NODE_ENV=production
ALLOWED_ORIGINS=https://app.talenttrust.com,https://admin.talenttrust.com
```

**Invalid (will fail in production)**:
```bash
NODE_ENV=production
ALLOWED_ORIGINS=*  # ERROR: Wildcard not allowed in production
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

Run tests using:
```bash
npm test
```
