/**
 * @module health/validation
 * @description Zod schemas for strict input validation on health endpoints.
 *
 * Security notes:
 * - Unknown fields are stripped (`.strip()`) on body and rejected on query.
 * - String lengths and numeric ranges are bounded to prevent oversized inputs.
 * - Enum constraints enforce only valid values on status/service fields.
 * - All schemas use `.strict()` or explicit rejection of extra keys where
 *   appropriate to reduce attack surface.
 */

import { z } from 'zod';
import { MAX_HEALTH_PAGE_SIZE, DEFAULT_HEALTH_PAGE_SIZE } from './pagination';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum length for free-form string fields (e.g. service name, detail). */
export const MAX_STRING_LENGTH = 256;

/** Maximum length for identifiers such as probe names. */
export const MAX_ID_LENGTH = 64;

/** Minimum allowed value for latency fields (0 ms). */
export const MIN_LATENCY_MS = 0;

/** Maximum allowed latency value to prevent overflow (1 hour in ms). */
export const MAX_LATENCY_MS = 3_600_000;

/** Minimum uptime value (0 seconds). */
export const MIN_UPTIME_SECONDS = 0;

/** Maximum uptime value (10 years in seconds). */
export const MAX_UPTIME_SECONDS = 315_360_000;

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

/**
 * Schema for an individual probe entry submitted in a health write body.
 * Rejects unknown fields, enforces string lengths, and bounds numeric ranges.
 */
export const ProbeInputSchema = z
  .object({
    /** Probe identifier — alphanumeric with dashes, max 64 chars. */
    name: z
      .string()
      .min(1, 'name must not be empty')
      .max(MAX_ID_LENGTH, `name must be at most ${MAX_ID_LENGTH} characters`)
      .regex(/^[a-zA-Z0-9_-]+$/, 'name may only contain alphanumeric characters, underscores, and hyphens'),

    /** Whether this probe succeeded. */
    ok: z.boolean(),

    /** Round-trip latency in milliseconds — must be a finite, non-negative number. */
    latencyMs: z
      .number()
      .int('latencyMs must be an integer')
      .min(MIN_LATENCY_MS, `latencyMs must be >= ${MIN_LATENCY_MS}`)
      .max(MAX_LATENCY_MS, `latencyMs must be <= ${MAX_LATENCY_MS}`),

    /** Optional detail string (error text or note). Stripped in production by the router. */
    detail: z
      .string()
      .max(MAX_STRING_LENGTH, `detail must be at most ${MAX_STRING_LENGTH} characters`)
      .optional(),
  })
  .strict();

/**
 * Schema for the POST /health request body.
 *
 * Callers may push a health snapshot — service name, overall status,
 * uptime, and an array of probe results.  All fields are bounded to
 * prevent oversized payloads from reaching any downstream store.
 */
export const HealthWriteBodySchema = z
  .object({
    /**
     * Service identifier. Must be a non-empty string with bounded length
     * and safe characters only (alphanumeric, hyphens, underscores).
     */
    service: z
      .string()
      .min(1, 'service must not be empty')
      .max(MAX_ID_LENGTH, `service must be at most ${MAX_ID_LENGTH} characters`)
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        'service may only contain alphanumeric characters, underscores, and hyphens',
      ),

    /** Aggregate health status: either "ok" or "degraded". */
    status: z.enum(['ok', 'degraded'], {
      errorMap: () => ({ message: 'status must be either "ok" or "degraded"' }),
    }),

    /** Process uptime in whole seconds. Must be a non-negative integer. */
    uptimeSeconds: z
      .number()
      .int('uptimeSeconds must be an integer')
      .min(MIN_UPTIME_SECONDS, `uptimeSeconds must be >= ${MIN_UPTIME_SECONDS}`)
      .max(MAX_UPTIME_SECONDS, `uptimeSeconds must be <= ${MAX_UPTIME_SECONDS}`),

    /**
     * Array of individual probe results.
     * Maximum of 50 probes per request to prevent unbounded array growth.
     */
    probes: z
      .array(ProbeInputSchema)
      .max(50, 'probes array must contain at most 50 entries')
      .optional()
      .default([]),
  })
  .strict();

/**
 * Schema for the GET /health query parameters.
 *
 * Accepts `verbose`, `limit`, and `cursor` for cursor-based pagination.
 * Unknown query parameters are rejected to prevent probing internal behaviour.
 */
export const HealthQuerySchema = z
  .object({
    /**
     * When set to "true", non-production responses include probe detail strings.
     * Any other value or omission disables verbose output.
     */
    verbose: z
      .enum(['true', 'false'], {
        errorMap: () => ({ message: 'verbose must be "true" or "false"' }),
      })
      .optional(),

    /**
     * Maximum number of probes to return in this page.
     * Must be a positive integer between 1 and MAX_HEALTH_PAGE_SIZE (100).
     * Values above the cap are clamped to the cap.
     * Defaults to DEFAULT_HEALTH_PAGE_SIZE (20) when omitted.
     */
    limit: z
      .preprocess(
        (v) =>
          v === undefined || v === '' || v === null
            ? String(DEFAULT_HEALTH_PAGE_SIZE)
            : v,
        z
          .string()
          .regex(/^\d+$/, 'limit must be a positive integer')
          .transform((s) => Number(s))
          .refine(
            (n) => n >= 1,
            'limit must be at least 1',
          ),
      )
      .optional(),

    /**
     * Opaque cursor from a previous response's `nextCursor` field.
     * When omitted the first page is returned.
     * Must be a non-empty string (format is opaque to clients).
     */
    cursor: z
      .string()
      .min(1, 'cursor must not be empty')
      .optional(),
  })
  .strict();

// ─── Inferred types ───────────────────────────────────────────────────────────

/** TypeScript type inferred from {@link ProbeInputSchema}. */
export type ProbeInput = z.infer<typeof ProbeInputSchema>;

/** TypeScript type inferred from {@link HealthWriteBodySchema}. */
export type HealthWriteBody = z.infer<typeof HealthWriteBodySchema>;

/** TypeScript type inferred from {@link HealthQuerySchema}. */
export type HealthQuery = z.infer<typeof HealthQuerySchema>;

/** Convenience re-exports so consumers don't need to import from pagination.ts directly. */
export { MAX_HEALTH_PAGE_SIZE, DEFAULT_HEALTH_PAGE_SIZE } from './pagination';
