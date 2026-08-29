import { z } from 'zod';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, CURSOR_MAX_LENGTH } from '../../../contracts/cursor.types';
import type { CreateWebhookSubscriptionDto, UpdateWebhookSubscriptionDto, WebhookSubscription } from '../../../types/webhook.types';

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