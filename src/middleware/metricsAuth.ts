/**
 * @module middleware/metricsAuth
 * @description Bearer token guard for the /metrics endpoint.
 *
 * When `METRICS_AUTH_TOKEN` is set in the environment the middleware requires
 * every request to supply a matching `Authorization: Bearer <token>` header.
 * Comparison is performed with `crypto.timingSafeEqual` to prevent timing
 * side-channel attacks.
 *
 * When the env var is absent the middleware is a no-op, allowing unauthenticated
 * access in development / test environments.
 *
 * @security
 *  - Never logs the expected or received token value.
 *  - Returns a generic 401 Unauthorized for both missing and incorrect tokens.
 */

import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";

/**
 * Express middleware that protects a route with a static bearer token.
 *
 * Mount it directly in front of any route that must be authenticated:
 * ```ts
 * app.get('/metrics', metricsAuthMiddleware, metricsHandler);
 * ```
 */
export function metricsAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configuredToken = process.env["METRICS_AUTH_TOKEN"];

  // No token configured — allow access (development / non-production mode).
  if (!configuredToken) {
    next();
    return;
  }

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const provided = authHeader.slice(7); // strip "Bearer "

  // Constant-time comparison to prevent timing attacks.
  const configuredBuf = Buffer.from(configuredToken);
  const providedBuf = Buffer.from(provided);

  const isValid =
    configuredBuf.length === providedBuf.length &&
    timingSafeEqual(configuredBuf, providedBuf);

  if (!isValid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
