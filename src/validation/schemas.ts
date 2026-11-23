import { z } from 'zod';

/*
 * These validators are the single source of truth for the request schemas in
 * the published OpenAPI document: src/openapi.ts derives them with
 * z.toJSONSchema (see requestSchema there). `.meta({ description })` text ends
 * up in the spec. Rules a JSON Schema cannot express (`.refine`) use the
 * message constants below, which the spec lists in the operation description.
 */

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
export const Amount = z
  .union([
    z.number().int().positive().refine(Number.isSafeInteger, 'amount must be a safe integer; use a decimal string for larger values'),
    z.string().regex(/^[1-9][0-9]{0,38}$/, 'amount string must be a positive decimal integer without leading zeros'),
  ])
  .meta({
    description:
      'Amount in token base units (e.g. stroops): a positive safe integer, or a positive decimal integer string without leading zeros for larger values.',
  });

export const MilestoneItem = z.union([
  Amount,
  z
    .object({
      title: z.string().max(120).optional(),
      amount: Amount,
    })
    .strict(),
]);

/** 1–20 milestones, each a bare amount or `{ title?, amount }`. */
export const Milestones = z.array(MilestoneItem).min(1).max(20);

/** Messages of the CreateContractBody refinements (also listed in the OpenAPI operation description). */
export const CREATE_CONTRACT_RULES = {
  distinctParties: 'client and freelancer must differ',
  notBoth: 'Cannot provide both templateId and milestones',
  oneOf: 'Either templateId or milestones must be provided',
  budgetOnlyWithTemplate: 'budget must not be provided when using milestones directly',
} as const;

export const CreateContractBody = z
  .object({
    title: z.string().max(120).trim().optional(),
    client: z.string().min(1),
    freelancer: z.string().min(1),
    token: z.string().max(64).optional().meta({ description: 'Token code; defaults to XLM' }),
    milestones: Milestones.optional(),
    // Validated (range-checked against the store clock) by EscrowStore.create.
    fundingDeadline: z.string().optional().meta({
      format: 'date-time',
      description: 'ISO-8601 deadline, from 1 hour through 90 days after creation (default 14 days); checked by the store',
    }),
    /** Create from a saved milestone template instead of explicit milestones. */
    templateId: z.number().int().positive().optional().meta({
      description: 'Create from a milestone template instead of `milestones` (exactly one of the two is required)',
    }),
    /** Total budget (base units) for percent-mode templates. */
    budget: Amount.optional().meta({
      description: 'Total budget in base units; required for percent templates, forbidden otherwise',
    }),
  })
  .strict()
  .refine((data) => data.client !== data.freelancer, {
    message: CREATE_CONTRACT_RULES.distinctParties,
    path: ['freelancer'],
  })
  .refine((data) => !(data.templateId !== undefined && data.milestones !== undefined), {
    message: CREATE_CONTRACT_RULES.notBoth,
    path: ['milestones'],
  })
  .refine((data) => data.templateId !== undefined || data.milestones !== undefined, {
    message: CREATE_CONTRACT_RULES.oneOf,
    path: ['milestones'],
  })
  .refine((data) => !(data.milestones !== undefined && data.budget !== undefined), {
    message: CREATE_CONTRACT_RULES.budgetOnlyWithTemplate,
    path: ['budget'],
  });

// --- Milestone templates ---

export const TemplateModeEnum = z.enum(['fixed', 'percent']);

export const TemplateIdParam = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,15}$/, 'id must be a positive integer'),
});

export const TemplateMilestoneItem = z.union([
  z.object({ title: z.string().max(120).optional(), amount: Amount }).strict(),
  z.object({ title: z.string().max(120).optional(), percentBps: z.number().int().positive().max(10000) }).strict(),
]);

type TemplateMilestoneInput = z.infer<typeof TemplateMilestoneItem>;
const sumBps = (ms: TemplateMilestoneInput[]) => ms.reduce((sum, m) => sum + ('percentBps' in m ? m.percentBps : 0), 0);
const matchesMode = (mode: 'fixed' | 'percent', ms: TemplateMilestoneInput[]) =>
  ms.every((m) => (mode === 'fixed' ? 'amount' in m : 'percentBps' in m));

/** Messages of the template refinements (also listed in the OpenAPI operation descriptions). */
export const TEMPLATE_RULES = {
  matchMode: 'milestones must match mode (amount for fixed, percentBps for percent)',
  percentSum: 'percentBps must sum to exactly 10000',
  updateNoMix: 'milestones must not mix amount and percentBps, and must match mode',
} as const;

export const CreateTemplateBody = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1).max(80).trim(),
    description: z.string().max(500).optional(),
    mode: TemplateModeEnum,
    milestones: z.array(TemplateMilestoneItem).min(1).max(20),
  })
  .strict()
  .refine((d) => matchesMode(d.mode, d.milestones), {
    message: TEMPLATE_RULES.matchMode,
    path: ['milestones'],
  })
  .refine((d) => d.mode !== 'percent' || sumBps(d.milestones) === 10000, {
    message: TEMPLATE_RULES.percentSum,
    path: ['milestones'],
  });

export const UpdateTemplateBody = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1).max(80).trim().optional(),
    description: z.string().max(500).optional(),
    mode: TemplateModeEnum.optional(),
    milestones: z.array(TemplateMilestoneItem).min(1).max(20).optional(),
  })
  .strict()
  .refine(
    (d) =>
      !d.milestones ||
      (d.mode ? matchesMode(d.mode, d.milestones) : matchesMode('fixed', d.milestones) || matchesMode('percent', d.milestones)),
    { message: TEMPLATE_RULES.updateNoMix, path: ['milestones'] },
  );

export const TemplateOwnerQuery = z.object({ owner: z.string().min(1) }).strict();

export const DeleteTemplateBody = z.object({ owner: z.string().min(1) }).strict();


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
    freelancerBps: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .meta({ description: "Freelancer's share of the escrowed funds in basis points; the rest is refunded to the client" }),
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

export const ReputationListQuery = z
  .object({
    sort: z.string().optional(),
    minCompleted: z.string().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
    since: z.string().optional(),
    windowDays: z.string().optional(),
  })
  .strict();

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
export type ReputationListQueryType = z.infer<typeof ReputationListQuery>;
