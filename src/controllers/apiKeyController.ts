/**
 * @module apiKeyController
 * @description Controller for API key management operations.
 *
 * Provides endpoints for creating, viewing, rotating, and deactivating API keys.
 * These endpoints should be protected by JWT authentication (not API key auth).
 *
 * ## Request validation contract (POST /api/v1/api-keys)
 *
 * All write operations pass through {@link validateApiKeyRequestBody} before
 * reaching the store. The validator enforces:
 *
 * | Field      | Type       | Constraints                                      |
 * |------------|------------|--------------------------------------------------|
 * | `name`     | `string`   | Required. 1–100 characters.                      |
 * | `scope`    | `string[]` | Required. 1–20 items. Each item 1–64 characters. |
 * | `expiresAt`| `string`   | Optional. Must be a valid ISO-8601 date string.  |
 *
 * Unknown top-level fields are rejected with a structured 400 that includes
 * `code: "UNKNOWN_FIELDS"` so callers can distinguish this from other errors.
 *
 * All 400 responses carry a machine-readable `code` field:
 * - `"MISSING_FIELDS"`   — required field absent or wrong type
 * - `"INVALID_SCOPE"`    — one or more scope items fail the format check
 * - `"UNKNOWN_FIELDS"`   — request body contains unexpected keys
 * - `"OUT_OF_RANGE"`     — a value exceeds the allowed length / count bound
 * - `"INVALID_DATE"`     — `expiresAt` is not a valid ISO-8601 date
 *
 * ## State invariants
 *
 * - Ownership: only the creator (`created_by === req.user.userId`) may read,
 *   rotate, or deactivate a key. Checked before any mutation.
 * - Rotation/deactivation are idempotent-safe: a key that is already inactive
 *   cannot be rotated or deactivated again; the controller returns 409.
 * - The plaintext key is returned exactly once (create/rotate) and never
 *   persisted in responses for list/get.
 */

import { Response } from 'express';
import { createApiKey, rotateApiKey, deactivateApiKey } from '../auth/apiKeys';
import { database } from '../database';
import { AuthenticatedRequest } from '../auth/authenticate';
import { decodeCursor } from '../contracts/cursor.repository';

// ─── Validation constants ────────────────────────────────────────────────────

/** Maximum allowed length for an API key name. */
const NAME_MAX_LEN = 100;
/** Minimum allowed length for an API key name. */
const NAME_MIN_LEN = 1;
/** Maximum number of scope items on a single key. */
const SCOPE_MAX_ITEMS = 20;
/** Maximum character length of a single scope item. */
const SCOPE_ITEM_MAX_LEN = 64;
/** Allowed top-level fields on the create request body. */
const ALLOWED_CREATE_FIELDS = new Set(['name', 'scope', 'expiresAt']);
/** Maximum allowed length for an API key id path parameter. */
const ID_MAX_LEN = 128;

// ─── Failure observability ───────────────────────────────────────────────────

/**
 * Emits a structured, redacted error log for a controller failure.
 *
 * Deterministic recovery requires that every failure path be observable
 * without leaking secrets (API key material, tokens, request bodies). We log
 * only the operation name, the authenticated user id (if any), the request
 * id (if the request carries one), and the error message/name — never the
 * raw error object, request body, or headers.
 *
 * @param operation - Stable identifier for the failing operation.
 * @param req - The authenticated request (used for redacted correlation ids).
 * @param error - The thrown value; only `name`/`message` are surfaced.
 */
function logControllerFailure(operation: string, req: AuthenticatedRequest, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(
    JSON.stringify({
      level: 'error',
      operation,
      userId: req.user?.userId ?? null,
      requestId: (req as unknown as { id?: string }).id ?? null,
      errorName: err.name,
      errorMessage: err.message,
    })
  );
}

// ─── Concurrency guards ──────────────────────────────────────────────────────

/** In-flight mutation locks keyed by API key id, to serialize rotate/deactivate. */
const inFlightMutations = new Map<string, Promise<unknown>>();

// ─── Validation helper ───────────────────────────────────────────────────────

/**
 * Validates a path `:id` parameter for API key routes.
 *
 * Rejects empty, non-string, oversized, or malformed ids before they reach
 * the store, so downstream lookups cannot be tricked into matching unintended
 * rows or triggering unbounded work.
 *
 * @param id - Raw `req.params.id`.
 * @returns `null` when valid; otherwise a 400-ready error object.
 */
export function validateApiKeyId(id: unknown): Record<string, unknown> | null {
  if (typeof id !== 'string' || id.length === 0) {
    return { code: 'INVALID_ID', error: '`id` must be a non-empty string' };
  }
  if (id.length > ID_MAX_LEN) {
    return {
      code: 'OUT_OF_RANGE',
      error: `\`id\` must be at most ${ID_MAX_LEN} characters`,
      maxLength: ID_MAX_LEN,
      received: id.length,
    };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return { code: 'INVALID_ID', error: '`id` contains invalid characters' };
  }
  return null;
}

/**
 * Validates and bounds the request body for API key creation.
 *
 * Enforces:
 * - No unknown top-level fields (`code: "UNKNOWN_FIELDS"`).
 * - `name` is a non-empty string within {@link NAME_MAX_LEN} characters (`code: "MISSING_FIELDS"` / `"OUT_OF_RANGE"`).
 * - `scope` is a non-empty array of at most {@link SCOPE_MAX_ITEMS} items, each a string
 *   of at most {@link SCOPE_ITEM_MAX_LEN} characters in `resource:action` / wildcard format
 *   (`code: "MISSING_FIELDS"` / `"OUT_OF_RANGE"` / `"INVALID_SCOPE"`).
 * - `expiresAt`, when present, is a valid ISO-8601 date string (`code: "INVALID_DATE"`).
 *
 * @param body - Raw `req.body` from Express.
 * @returns `null` when the body is valid; otherwise a `{ code, error, ... }` object
 *   suitable for sending directly as a 400 JSON response.
 *
 * Invariant: this function is pure — it never mutates `body` and never
 * touches the store. Callers must invoke it before any state transition.
 */
export function validateApiKeyRequestBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { code: 'MISSING_FIELDS', error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  // ── Unknown fields ─────────────────────────────────────────────────────────
  const unknownFields = Object.keys(obj).filter((k) => !ALLOWED_CREATE_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return {
      code: 'UNKNOWN_FIELDS',
      error: 'Request body contains unknown fields',
      unknownFields,
      allowedFields: [...ALLOWED_CREATE_FIELDS],
    };
  }

  // ── name ───────────────────────────────────────────────────────────────────
  if (typeof obj['name'] !== 'string' || obj['name'].trim().length < NAME_MIN_LEN) {
    return {
      code: 'MISSING_FIELDS',
      error: '`name` is required and must be a non-empty string',
    };
  }
  if (obj['name'].length > NAME_MAX_LEN) {
    return {
      code: 'OUT_OF_RANGE',
      error: `\`name\` must be at most ${NAME_MAX_LEN} characters`,
      maxLength: NAME_MAX_LEN,
      received: obj['name'].length,
    };
  }

  // ── scope ──────────────────────────────────────────────────────────────────
  if (!Array.isArray(obj['scope']) || obj['scope'].length === 0) {
    return {
      code: 'MISSING_FIELDS',
      error: '`scope` is required and must be a non-empty array of strings',
    };
  }
  if (obj['scope'].length > SCOPE_MAX_ITEMS) {
    return {
      code: 'OUT_OF_RANGE',
      error: `\`scope\` must contain at most ${SCOPE_MAX_ITEMS} items`,
      maxItems: SCOPE_MAX_ITEMS,
      received: obj['scope'].length,
    };
  }

  const nonStringScopes = (obj['scope'] as unknown[]).filter((s) => typeof s !== 'string');
  if (nonStringScopes.length > 0) {
    return {
      code: 'MISSING_FIELDS',
      error: 'Each item in `scope` must be a string',
    };
  }

  const oversizedScopes = (obj['scope'] as string[]).filter((s) => s.length > SCOPE_ITEM_MAX_LEN);
  if (oversizedScopes.length > 0) {
    return {
      code: 'OUT_OF_RANGE',
      error: `Each scope item must be at most ${SCOPE_ITEM_MAX_LEN} characters`,
      maxLength: SCOPE_ITEM_MAX_LEN,
      oversizedItems: oversizedScopes,
    };
  }

  const invalidScopes = (obj['scope'] as string[]).filter((s: string) => {
    if (s === '*') return false;
    if (s.endsWith(':*')) {
      const resource = s.slice(0, -2);
      return !resource || !/^[a-z-]+$/.test(resource);
    }
    if (s.startsWith('*:')) {
      const action = s.slice(2);
      return !action || !/^[a-z-]+$/.test(action);
    }
    const parts = s.split(':');
    if (parts.length !== 2) return true;
    const [resource, action] = parts;
    return !resource || !action || !/^[a-z-]+$/.test(resource) || !/^[a-z-]+$/.test(action);
  });

  if (invalidScopes.length > 0) {
    return {
      code: 'INVALID_SCOPE',
      error: 'One or more scope items have an invalid format',
      invalidScopes,
      validFormats: ['resource:action', 'resource:*', '*:action', '*'],
    };
  }

  // ── expiresAt (optional) ──────────────────────────────────────────────────
  if (obj['expiresAt'] !== undefined) {
    if (typeof obj['expiresAt'] !== 'string') {
      return { code: 'INVALID_DATE', error: '`expiresAt` must be an ISO-8601 date string' };
    }
    const d = new Date(obj['expiresAt']);
    if (isNaN(d.getTime())) {
      return {
        code: 'INVALID_DATE',
        error: '`expiresAt` is not a valid ISO-8601 date string',
        received: obj['expiresAt'],
      };
    }
    // Invariant: an already-expired key must not be created — it would be
    // unusable on arrival and would silently violate the "active key" contract.
    if (d.getTime() <= Date.now()) {
      return {
        code: 'INVALID_DATE',
        error: '`expiresAt` must be in the future',
        received: obj['expiresAt'],
      };
    }
  }

  return null; // valid
}

/**
 * Serializes async mutations for a given API key id.
 *
 * Concurrent rotate/deactivate requests for the same key are chained so that
 * only one store mutation is in flight at a time. This prevents lost updates
 * and stale reads (e.g. two rotations racing, or a deactivate racing a rotate).
 *
 * The lock entry is removed once the chained promise settles, so the map does
 * not grow unbounded. Errors from the previous holder are swallowed here and
 * surfaced to their own caller; the next holder still runs.
 */
async function withApiKeyLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = inFlightMutations.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const guarded = run.finally(() => {
    if (inFlightMutations.get(id) === guarded) {
      inFlightMutations.delete(id);
    }
  });
  inFlightMutations.set(id, guarded);
  return guarded;
}

/**
 * Create a new API key.
 *
 * Validates the request body via {@link validateApiKeyRequestBody} before
 * touching the store. Returns 400 with a machine-readable `code` on any
 * validation failure.
 *
 * @route POST /api/v1/api-keys
 * @access Private (requires JWT authentication)
 * @body { name: string, scope: string[], expiresAt?: string }
 */
export async function createApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    // Auth check first: never validate/echo body for unauthenticated callers.
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const validationError = validateApiKeyRequestBody(req.body);
    if (validationError) {
      res.status(400).json(validationError);
      return;
    }

    const { name, scope, expiresAt } = req.body as { name: string; scope: string[]; expiresAt?: string };

    const result = await createApiKey({
      name,
      scope,
      createdBy: req.user.userId,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });

    res.status(201).json({
      message: 'API key created successfully',
      apiKey: result.apiKey, // Only returned once
      info: result.info,
    });
  } catch (error) {
    logControllerFailure('createApiKey', req, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * List API keys for the authenticated user.
 *
 * Cursor-paginated: `?limit=<n>` (1-100, default 20) bounds the page size and
 * `?cursor=<opaque>` resumes from the previous page's `nextCursor`. Existing
 * filters (owned-by-caller, active-only) apply identically across pages.
 *
 * @route GET /api/v1/api-keys
 * @access Private (requires JWT authentication)
 */
export async function listApiKeysController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Malformed/negative/over-max values are bounded rather than rejected —
    // see DatabaseService#listApiKeysPage for the clamp policy.
    const rawLimit = req.query['limit'];
    const limit = rawLimit !== undefined ? Number(rawLimit) : undefined;

    const rawCursor = req.query['cursor'];
    const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : undefined;
    if (cursor !== undefined) {
      try {
        decodeCursor(cursor);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }

    const pageResult = await database.listApiKeysPage(req.user.userId, { limit, cursor });

    // Remove sensitive data
    const safeKeys = pageResult.data.map((key) => ({
      id: key.id,
      name: key.name,
      scope: key.scope,
      created_at: key.created_at,
      updated_at: key.updated_at,
      expires_at: key.expires_at,
      last_used_at: key.last_used_at,
      is_active: key.is_active
    }));

    res.json({
      apiKeys: safeKeys,
      total: safeKeys.length,
      nextCursor: pageResult.nextCursor,
      hasNextPage: pageResult.hasNextPage,
      limit: pageResult.limit
    });
  } catch (error) {
    logControllerFailure('listApiKeys', req, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Rotate an existing API key.
 * 
 * @route POST /api/v1/api-keys/:id/rotate
 * @access Private (requires JWT authentication)
 */
export async function rotateApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = req.user.userId;

    // Serialize per-key so concurrent rotate/deactivate cannot interleave.
    const outcome = await withApiKeyLock(id, async () => {
      // Re-read inside the lock: ownership and existence may have changed
      // while a prior mutation was in flight.
      const existingKey = await database.getApiKeyById(id);
      if (!existingKey) {
        return { status: 404 as const, body: { error: 'API key not found' } };
      }

      if (existingKey.created_by !== userId) {
        return { status: 403 as const, body: { error: 'Access denied' } };
      }

      const result = await rotateApiKey(id);
      if (!result) {
        return { status: 404 as const, body: { error: 'API key not found' } };
      }

      return {
        status: 200 as const,
        body: {
          message: 'API key rotated successfully',
          apiKey: result.apiKey, // Only returned once
          info: result.info
        }
      };
    });

    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    logControllerFailure('rotateApiKey', req, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Deactivate an API key.
 * 
 * @route DELETE /api/v1/api-keys/:id
 * @access Private (requires JWT authentication)
 */
export async function deactivateApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = req.user.userId;

    // Serialize per-key so concurrent rotate/deactivate cannot interleave.
    const outcome = await withApiKeyLock(id, async () => {
      // Re-read inside the lock: ownership and existence may have changed
      // while a prior mutation was in flight.
      const existingKey = await database.getApiKeyById(id);
      if (!existingKey) {
        return { status: 404 as const, body: { error: 'API key not found' } };
      }

      if (existingKey.created_by !== userId) {
        return { status: 403 as const, body: { error: 'Access denied' } };
      }

      const success = await deactivateApiKey(id);
      if (!success) {
        return { status: 404 as const, body: { error: 'API key not found' } };
      }

      return {
        status: 200 as const,
        body: { message: 'API key deactivated successfully' }
      };
    });

    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    logControllerFailure('deactivateApiKey', req, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get details of a specific API key.
 * 
 * @route GET /api/v1/api-keys/:id
 * @access Private (requires JWT authentication)
 */
export async function getApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const idError = validateApiKeyId(id);
    if (idError) {
      res.status(400).json(idError);
      return;
    }

    const apiKey = await database.getApiKeyById(id);
    if (!apiKey) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    if (apiKey.created_by !== req.user.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Remove sensitive data
    const safeKey = {
      id: apiKey.id,
      name: apiKey.name,
      scope: apiKey.scope,
      created_at: apiKey.created_at,
      updated_at: apiKey.updated_at,
      expires_at: apiKey.expires_at,
      last_used_at: apiKey.last_used_at,
      is_active: apiKey.is_active
    };

    res.json(safeKey);
  } catch (error) {
    logControllerFailure('getApiKey', req, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
