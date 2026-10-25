import { z } from 'zod';

export const ContractStatusEnum = z.enum([
  'Created',
  'Funded',
  'Completed',
  'Disputed',
  'Resolved',
  'Cancelled',
  'Expired',
]);

export type ContractStatus = z.infer<typeof ContractStatusEnum>;

export const IdParam = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,15}$/, 'id must be a positive integer'),
});

export const MilestoneIndexParam = z.object({
  index: z.string().regex(/^(?:[0-9]|1[0-9])$/, 'index must be an integer 0..19'),
});

export const MilestoneReleaseParams = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,15}$/, 'id must be a positive integer'),
  index: z.string().regex(/^(?:[0-9]|1[0-9])$/, 'index must be an integer 0..19'),
});

/**
 * Token base-unit amount: a positive safe integer, or a canonical decimal
 * string (no sign, no leading zeros, no exponent) for values beyond 2^53.
 * Mirrors parseAmount() in src/amount.ts; the store still enforces the i128 cap.
 */
export const Amount = z.union([
  z.number().int().positive().refine(Number.isSafeInteger, 'amount must be a safe integer; use a decimal string for larger values'),
  z.string().regex(/^[1-9][0-9]{0,38}$/, 'amount string must be a positive decimal integer without leading zeros'),
]);

export const MilestoneItem = z.union([
  Amount,
  z
    .object({
      title: z.string().max(120).optional(),
      amount: Amount,
    })
    .strict(),
]);

export const CreateContractBody = z
  .object({
    title: z.string().max(120).trim().optional(),
    client: z.string().min(1),
    freelancer: z.string().min(1),
    token: z.string().max(64).optional(),
    milestones: z.array(MilestoneItem).min(1).max(20),
    // Validated (range-checked against the store clock) by EscrowStore.create.
    fundingDeadline: z.string().optional(),
  })
  .strict()
  .refine((data) => data.client !== data.freelancer, {
    message: 'client and freelancer must differ',
    path: ['freelancer'],
  });

export const DepositBody = z
  .object({
    amount: Amount,
  })
  .strict();

export const DisputeBody = z
  .object({
    raisedBy: z.string().min(1).optional(),
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const ResolveBody = z
  .object({
    freelancerBps: z.number().int().min(0).max(10_000),
  })
  .strict();

export const RateBody = z
  .object({
    rating: z.number().int().min(1).max(5),
  })
  .strict();

export const CancelBody = z.object({}).strict();

export const ListQuery = z
  .object({
    // Comma-separated statuses; each value is checked by the route (invalid_query).
    status: z.string().optional(),
    party: z.string().max(64).optional(),
    role: z.string().optional(),
    token: z.string().optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
    sort: z.string().optional(),
    linked: z.enum(['true', 'false']).optional(),
    fields: z.string().optional(),
  })
  .strict();

export const ReputationAddressParam = z.object({
  address: z.string().min(1),
});

export type IdParamType = z.infer<typeof IdParam>;
export type MilestoneIndexParamType = z.infer<typeof MilestoneIndexParam>;
export type MilestoneReleaseParamsType = z.infer<typeof MilestoneReleaseParams>;
export type CreateContractBodyType = z.infer<typeof CreateContractBody>;
export type DepositBodyType = z.infer<typeof DepositBody>;
export type DisputeBodyType = z.infer<typeof DisputeBody>;
export type ResolveBodyType = z.infer<typeof ResolveBody>;
export type RateBodyType = z.infer<typeof RateBody>;
export type CancelBodyType = z.infer<typeof CancelBody>;
export type ListQueryType = z.infer<typeof ListQuery>;
export type ReputationAddressParamType = z.infer<typeof ReputationAddressParam>;
