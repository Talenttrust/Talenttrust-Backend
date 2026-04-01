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
- **Allowed Methods**: `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`, `PATCH`.
- **Allowed Headers**: `Content-Type`, `Authorization`.
- **Credentials**: Enabled (Allows sending cookies/authorization headers).
- **Max Age**: 86400 seconds (24 hours cache for preflight requests).

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
