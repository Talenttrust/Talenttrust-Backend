import { z } from 'zod';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, CURSOR_MAX_LENGTH } from '../../../contracts/cursor.types';
import type { CreateWebhookSubscriptionDto, UpdateWebhookSubscriptionDto, WebhookSubscription } from '../../../types/webhook.types';

// ---------------------------------------------------------------------------
// Bulk operations — cap constant and schemas
// ---------------------------------------------------------------------------

/**
 * Maximum number of items allowed in a single bulk request.
 *
 * Capped at 25 to match the contracts bulk endpoint (POST /api/v1/contracts/bulk)
 * and to bound the number of sequential DB writes per request. Requests over this
 * limit are rejected outright with a 400 rather than silently truncated.
 *
 * Override at runtime with the WEBHOOK_BULK_MAX_ITEMS environment variable
 * (loaded in loadWebhookBulkConfig() in routes).
 */
export const MAX_WEBHOOK_BULK_BATCH_SIZE = 25;

export interface CreateWebhookSubscriptionRequestDto {
  consumerId?: string;
  url: string;
  eventType: string;
  secret?: string;
}

export interface UpdateWebhookSubscriptionRequestDto {
  url?: string;
  eventType?: string;
  secret?: string;
  active?: boolean;
}

export interface ListWebhookSubscriptionsQueryDto {
  consumerId?: string;
  eventType?: string;
  active?: boolean;
  cursor?: string;
  limit?: number;
}

export interface WebhookSubscriptionResponseDto {
  id: string;
  consumerId?: string;
  url: string;
  eventType: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toCreateWebhookSubscriptionDto(
  request: CreateWebhookSubscriptionRequestDto,
): CreateWebhookSubscriptionDto {
  return {
    ...(request.consumerId !== undefined && { consumerId: request.consumerId }),
    url: request.url,
    eventType: request.eventType,
    ...(request.secret !== undefined && { secret: request.secret }),
  };
}

export function toUpdateWebhookSubscriptionDto(
  request: UpdateWebhookSubscriptionRequestDto,
): UpdateWebhookSubscriptionDto {
  return {
    ...(request.url !== undefined && { url: request.url }),
    ...(request.eventType !== undefined && { eventType: request.eventType }),
    ...(request.secret !== undefined && { secret: request.secret }),
    ...(request.active !== undefined && { active: request.active }),
  };
}

export function toListWebhookSubscriptionsQueryDto(
  query: ListWebhookSubscriptionsQueryDto,
): ListWebhookSubscriptionsQueryDto {
  return {
    ...(query.consumerId !== undefined && { consumerId: query.consumerId }),
    ...(query.eventType !== undefined && { eventType: query.eventType }),
    ...(query.active !== undefined && { active: query.active }),
    ...(query.cursor !== undefined && { cursor: query.cursor }),
    ...(query.limit !== undefined && { limit: query.limit }),
  };
}

export function toWebhookSubscriptionResponseDto(
  subscription: WebhookSubscription,
): WebhookSubscriptionResponseDto {
  return {
    id: subscription.id,
    ...(subscription.consumerId !== undefined && { consumerId: subscription.consumerId }),
    url: subscription.url,
    eventType: subscription.eventType,
    active: subscription.active,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

export function fromWebhookSubscriptionResponseDto(
  dto: WebhookSubscriptionResponseDto,
): WebhookSubscription {
  return {
    id: dto.id,
    consumerId: dto.consumerId,
    url: dto.url,
    eventType: dto.eventType,
    active: dto.active,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

export const createWebhookSubscriptionSchema = z.object({
  body: z.object({
    consumerId: z.string().uuid().optional(),
    url: z.string().url(),
    eventType: z.string().min(1).max(100),
    secret: z.string().min(1).max(256).optional(),
  }),
});

export const updateWebhookSubscriptionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    url: z.string().url().optional(),
    eventType: z.string().min(1).max(100).optional(),
    secret: z.string().min(1).max(256).optional(),
    active: z.boolean().optional(),
  }),
});

export const getWebhookSubscriptionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listWebhookSubscriptionsQuerySchema = z.object({
  query: z.object({
    consumerId: z.string().uuid().optional(),
    eventType: z.string().optional(),
    active: z.preprocess((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      return val;
    }, z.boolean().optional()),
    cursor: z.string().max(CURSOR_MAX_LENGTH).optional(),
    limit: z.preprocess((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = Number(val);
      return Number.isFinite(n) ? n : val;
    }, z.number().int().min(1).max(CURSOR_MAX_LIMIT).optional()),
  }).partial(),
});

// ---------------------------------------------------------------------------
// Bulk operation item schemas
//
// Each item carries an explicit `operation` discriminant so a single endpoint
// can handle create, update, and delete in one batch — mirroring the contracts
// bulk pattern (POST /api/v1/contracts/bulk with action: create|update|delete).
//
// Per-item error format mirrors the reputation bulk pattern:
//   { index, success: false, error: { code, message } }
// ---------------------------------------------------------------------------

/**
 * A single "create" item inside a bulk request.
 * Fields mirror the body of POST /api/v1/webhook-subscriptions.
 */
export const bulkCreateItemSchema = z.object({
  operation: z.literal('create'),
  consumerId: z.string().uuid().optional(),
  url: z.string().url({ message: 'url must be a valid URL' }),
  eventType: z.string().min(1, 'eventType is required').max(100, 'eventType must not exceed 100 characters'),
  secret: z.string().min(1).max(256).optional(),
});

/**
 * A single "update" item inside a bulk request.
 * Fields mirror the body of PATCH /api/v1/webhook-subscriptions/:id.
 */
export const bulkUpdateItemSchema = z.object({
  operation: z.literal('update'),
  id: z.string().uuid({ message: 'id must be a valid UUID' }),
  url: z.string().url({ message: 'url must be a valid URL' }).optional(),
  eventType: z.string().min(1).max(100).optional(),
  secret: z.string().min(1).max(256).optional(),
  active: z.boolean().optional(),
});

/**
 * A single "delete" item inside a bulk request.
 */
export const bulkDeleteItemSchema = z.object({
  operation: z.literal('delete'),
  id: z.string().uuid({ message: 'id must be a valid UUID' }),
});

/**
 * Union of all three operation types for an individual bulk item.
 * Zod discriminated union on the `operation` field gives clear per-item error messages.
 */
export const bulkWebhookItemSchema = z.discriminatedUnion('operation', [
  bulkCreateItemSchema,
  bulkUpdateItemSchema,
  bulkDeleteItemSchema,
]);

export type BulkWebhookItem = z.infer<typeof bulkWebhookItemSchema>;
export type BulkCreateItem = z.infer<typeof bulkCreateItemSchema>;
export type BulkUpdateItem = z.infer<typeof bulkUpdateItemSchema>;
export type BulkDeleteItem = z.infer<typeof bulkDeleteItemSchema>;

/**
 * Per-item result shape for the bulk response.
 * Mirrors the reputation bulk pattern: { index, success, data?, error? }.
 * `data` is present on success; `error` is present on failure.
 */
export interface BulkWebhookItemResult {
  index: number;
  success: boolean;
  data?: WebhookSubscriptionResponseDto | { id: string; deleted: boolean };
  error?: { code: string; message: string };
}

/**
 * Top-level Zod schema for POST /api/v1/webhook-subscriptions/bulk.
 *
 * The items array is validated at the envelope level only for length bounds.
 * Each item is then validated individually in the handler so a single bad item
 * produces a per-item error rather than failing the whole batch.
 *
 * Cap: MAX_WEBHOOK_BULK_BATCH_SIZE (25). Requests over cap are rejected outright.
 * Empty batch: rejected with 400 — almost certainly a caller bug.
 */
export const bulkWebhookSubscriptionSchema = z.object({
  body: z.object({
    items: z
      .array(z.unknown())
      .min(1, 'items array must contain at least one item')
      .max(
        MAX_WEBHOOK_BULK_BATCH_SIZE,
        `items array must not exceed ${MAX_WEBHOOK_BULK_BATCH_SIZE} items`,
      ),
  }),
});