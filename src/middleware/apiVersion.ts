/**
 * @module middleware/apiVersion
 * @description API versioning middleware.
 *
 * Responsibilities:
 *  1. Extracts the API version from the URL path segment (e.g. `/api/v1/...`).
 *  2. Rejects unsupported / unknown versions with 410 Gone.
 *  3. Attaches deprecation headers when the version is deprecated:
 *       - `Deprecation: <RFC 7231 date>`
 *       - `Sunset: <RFC 7231 date>`
 *       - `Link: <upgrade-guide>; rel="successor-version"`
 *  4. Writes `X-API-Version` on every response so clients always know which
 *     version handled the request.
 *
 * @security
 *  - Version strings are validated against a strict allowlist to prevent
 *    path-traversal or injection via the version segment.
 */

import { Request, Response, NextFunction } from 'express';
import { getVersionConfig, CURRENT_VERSION } from '../versioning';

/** Allowlist pattern: only lowercase "v" followed by 1-3 digits. */
const VERSION_PATTERN = /^v\d{1,3}$/;

/**
 * Factory that returns a middleware bound to a specific API version string.
 *
 * Mount it directly on the versioned router prefix:
 * ```ts
 * app.use('/api/v1', apiVersionMiddleware('v1'), v1Router);
 * ```
 */
export function apiVersionMiddleware(version: string) {
  return function versionHandler(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Validate the version string against the allowlist.
    if (!VERSION_PATTERN.test(version)) {
      res.status(400).json({
        error: 'Bad Request',
        message: `Invalid API version format: ${version}`,
      });
      return;
    }

    const config = getVersionConfig(version);

    // Unknown version → 404.
    if (!config) {
      res.status(404).json({
        error: 'Not Found',
        message: `API version '${version}' does not exist.`,
        currentVersion: CURRENT_VERSION,
      });
      return;
    }

    // Unsupported (removed) version → 410 Gone.
    if (!config.supported) {
      res.status(410).json({
        error: 'Gone',
        message: `API version '${version}' has been removed.`,
        currentVersion: CURRENT_VERSION,
        upgradeGuide: config.upgradeGuide,
      });
      return;
    }

    // Always advertise the version that handled the request.
    res.setHeader('X-API-Version', version);

    // Attach deprecation headers when applicable.
    if (config.deprecated) {
      if (config.sunsetDate) {
        res.setHeader('Deprecation', config.sunsetDate);
        res.setHeader('Sunset', config.sunsetDate);
      }
      if (config.upgradeGuide) {
        res.setHeader(
          'Link',
          `<${config.upgradeGuide}>; rel="successor-version"`,
        );
      }
    }

    // Expose custom headers to browser clients.
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-API-Version, Deprecation, Sunset, Link',
    );

    next();
  };
}
