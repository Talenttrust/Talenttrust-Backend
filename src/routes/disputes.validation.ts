import { z } from 'zod';

export const createDisputeSchema = z.object({
  contractId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  raisedBy: z.string().uuid().optional(),
});

export const updateDisputeSchema = z.object({
  status: z.enum(['open', 'resolved', 'cancelled']).optional(),
  resolution: z.string().min(1).max(2000).optional(),
  resolvedBy: z.string().uuid().optional(),
});

export const disputeParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listDisputesQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.string().optional(),
  contractId: z.string().uuid().optional(),
});

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;
export type UpdateDisputeInput = z.infer<typeof updateDisputeSchema>;
export type DisputeParams = z.infer<typeof disputeParamsSchema>;
export type ListDisputesQuery = z.infer<typeof listDisputesQuerySchema>;
