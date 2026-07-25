import { z } from 'zod';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, CURSOR_MAX_LENGTH } from '../../../contracts/cursor.types';

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