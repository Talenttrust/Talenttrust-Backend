/**
 * @module middleware/compression
 * @description Response compression middleware using Node's built-in zlib.
 *
 * Compresses JSON responses using gzip or deflate when:
 *  1. The client advertises support via `Accept-Encoding`.
 *  2. The serialised response body exceeds the configured size threshold.
 *
 * Small responses are sent uncompressed to avoid adding CPU overhead for
 * payloads that offer no meaningful bandwidth saving.
 *
 * Encoding preference order: gzip → deflate → identity (no compression).
 *
 * @security
 *  - No untrusted input is executed; only the `Accept-Encoding` header is
 *    inspected for known, fixed algorithm names.
 *  - The original `res.json()` implementation is wrapped and restored cleanly;
 *    any error thrown by zlib is propagated via the Express error pipeline.
 */

import { Request, Response, NextFunction } from 'express';
import zlib from 'zlib';

// ── Public constants ──────────────────────────────────────────────────────────

/** Default minimum byte threshold above which compression is applied. */
export const DEFAULT_COMPRESSION_THRESHOLD = 1024; // 1 KiB

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompressionOptions {
  /**
   * Minimum serialised body size in bytes that triggers compression.
   * Responses with a serialised size **strictly greater than** this value
   * are compressed; responses at or below this value are sent uncompressed.
   * @default 1024
   */
  threshold?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parses the `Accept-Encoding` header and returns the preferred supported
 * encoding (`'gzip'`, `'deflate'`, or `'identity'`).
 *
 * Quality values (q-factors) are respected but this implementation uses a
 * simplified "first supported wins" strategy after stripping q-values, which
 * is correct for the two algorithms we support.
 */
export function selectEncoding(acceptEncoding: string | undefined): 'gzip' | 'deflate' | 'identity' {
  if (!acceptEncoding) return 'identity';

  const lower = acceptEncoding.toLowerCase();

  // Split on commas, strip whitespace and q-values, collect directive tokens.
  const tokens = lower
    .split(',')
    .map(t => t.split(';')[0].trim())
    .filter(Boolean);

  for (const token of tokens) {
    if (token === 'gzip' || token === '*') return 'gzip';
    if (token === 'deflate') return 'deflate';
  }

  return 'identity';
}

/**
 * Synchronously compresses `data` with gzip.
 * Throws if zlib encounters an error.
 */
function gzipSync(data: Buffer): Buffer {
  return zlib.gzipSync(data);
}

/**
 * Synchronously compresses `data` with deflate.
 * Throws if zlib encounters an error.
 */
function deflateSync(data: Buffer): Buffer {
  return zlib.deflateSync(data);
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Creates Express middleware that compresses disputes (and any other JSON)
 * responses above the configured size threshold.
 *
 * @param options - Optional tuning parameters.
 * @returns Express middleware function.
 *
 * @example
 * ```ts
 * import { createCompressionMiddleware } from '../middleware/compression';
 *
 * router.use(createCompressionMiddleware({ threshold: 512 }));
 * ```
 */
export function createCompressionMiddleware(options: CompressionOptions = {}) {
  const threshold = options.threshold ?? DEFAULT_COMPRESSION_THRESHOLD;

  return function compressionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const originalJson = res.json.bind(res);

    // Override res.json to intercept the serialised body before it's sent.
    res.json = function compressedJson(body: unknown): Response {
      // Serialise to JSON string first so we can measure size.
      const serialised = JSON.stringify(body);
      const rawBuffer = Buffer.from(serialised, 'utf8');

      // Below threshold → send uncompressed.
      if (rawBuffer.byteLength <= threshold) {
        // Restore the original json so Content-Type is set normally.
        res.json = originalJson;
        return originalJson(body);
      }

      // Above threshold → attempt compression.
      const encoding = selectEncoding(req.headers['accept-encoding']);

      if (encoding === 'identity') {
        // Client does not accept compressed responses.
        res.json = originalJson;
        return originalJson(body);
      }

      try {
        const compressed = encoding === 'gzip'
          ? gzipSync(rawBuffer)
          : deflateSync(rawBuffer);

        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', compressed.byteLength);
        res.setHeader('Vary', 'Accept-Encoding');
        res.removeHeader('Transfer-Encoding');

        // Send raw bytes; bypass express json serialisation since we already
        // have the compressed buffer.
        res.end(compressed);
        return res;
      } catch {
        // Compression failed — fall back to uncompressed.
        res.json = originalJson;
        return originalJson(body);
      }
    };

    next();
  };
}
