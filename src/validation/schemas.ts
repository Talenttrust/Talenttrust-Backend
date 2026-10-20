import { z } from 'zod';

export const ContractStatusEnum = z.enum([
  'Created',
  'Funded',
  'Completed',
  'Disputed',
  'Resolved',
  'Cancelled',
]);

export const TemplateModeEnum = z.enum(['fixed', 'percent']);

export type ContractStatus = z.infer<typeof ContractStatusEnum>;
export type TemplateMode = z.infer<typeof TemplateModeEnum>;

export const IdParam = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,15}$/, 'id must be a positive integer'),
});

export const TemplateIdParam = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,15}$/, 'id must be a positive integer'),
});

export const MilestoneIndexParam = z.object({
  index: z.string().regex(/^(?:[0-9]|1[0-9])$/, 'index must be an integer 0..19'),
});

export const MilestoneReleaseParams = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,15}$/, 'id must be a positive integer'),
  index: z.string().regex(/^(?:[0-9]|1[0-9])$/, 'index must be an integer 0..19'),
});

export const TemplateMilestoneItem = z.union([
  z.object({
    title: z.string().max(120).optional(),
    amount: z.number().int().positive(),
  }).strict(),
  z.object({
    title: z.string().max(120).optional(),
    percentBps: z.number().int().positive(),
  }).strict(),
]);

export const CreateTemplateBody = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1).max(80).trim(),
    description: z.string().max(500).optional(),
    mode: TemplateModeEnum,
    milestones: z.array(TemplateMilestoneItem).min(1).max(20),
  })
  .strict()
  .refine(
    (data) => {
      if (data.mode === 'percent') {
        const totalBps = data.milestones.reduce((sum, m) => {
          if ('percentBps' in m) return sum + m.percentBps;
          return sum;
        }, 0);
        return totalBps === 10000;
      }
      return true;
    },
    { message: 'percentBps must sum to exactly 10000', path: ['milestones'] },
  )
  .refine(
    (data) => {
      if (data.mode === 'fixed') {
        return data.milestones.every((m) => 'amount' in m);
      }
      return data.milestones.every((m) => 'percentBps' in m);
    },
    { message: 'milestones must match mode (amount for fixed, percentBps for percent)', path: ['milestones'] },
  );

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
    (data) => {
      if (data.mode === 'percent' && data.milestones) {
        const totalBps = data.milestones.reduce((sum, m) => {
          if ('percentBps' in m) return sum + m.percentBps;
          return sum;
        }, 0);
        return totalBps === 10000;
      }
      if (data.mode === 'fixed' && data.milestones) {
        return data.milestones.every((m) => 'amount' in m);
      }
      if (data.milestones && !data.mode) {
        const hasAmount = data.milestones.some((m) => 'amount' in m);
        const hasPercent = data.milestones.some((m) => 'percentBps' in m);
        return !hasAmount || !hasPercent;
      }
      return true;
    },
    { message: 'percentBps must sum to exactly 10000 for percent mode, or milestones must match mode', path: ['milestones'] },
  );

export const TemplateOwnerQuery = z.object({ owner: z.string().min(1) }).strict();

export const DeleteTemplateBody = z
  .object({
    owner: z.string().min(1),
  })
  .strict();

export const MilestoneItem = z.union([
  z.number().int().positive(),
  z.object({
    title: z.string().max(120).optional(),
    amount: z.number().int().positive(),
  }).strict(),
]);

export const CreateContractBody = z
  .object({
    title: z.string().max(120).trim().optional(),
    client: z.string().min(1),
    freelancer: z.string().min(1),
    token: z.string().max(64).optional(),
    milestones: z.array(MilestoneItem).min(1).max(20).optional(),
    templateId: z.number().int().positive().optional(),
    budget: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (data) => {
      const hasTemplate = data.templateId !== undefined;
      const hasMilestones = data.milestones !== undefined && data.milestones.length > 0;
      return !(hasTemplate && hasMilestones);
    },
    { message: 'Cannot provide both templateId and milestones', path: ['milestones'] },
  )
  .refine(
    (data) => {
      const hasTemplate = data.templateId !== undefined;
      const hasMilestones = data.milestones !== undefined && data.milestones.length > 0;
      return hasTemplate || hasMilestones;
    },
    { message: 'Either templateId or milestones must be provided', path: ['milestones'] },
  )
  .refine(
    (data) => {
      if (data.milestones !== undefined && data.milestones.length > 0 && data.budget !== undefined) {
        return false;
      }
      return true;
    },
    { message: 'budget must not be provided when using milestones directly', path: ['budget'] },
  );

export const DepositBody = z
  .object({
    amount: z.number().int().positive(),
  })
  .strict();

export const DisputeBody = z
  .object({
    raisedBy: z.string().min(1),
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
    status: ContractStatusEnum.optional(),
    party: z.string().max(64).optional(),
  })
  .strict();

export const ReputationAddressParam = z.object({
  address: z.string().min(1),
});

export type IdParamType = z.infer<typeof IdParam>;
export type TemplateIdParamType = z.infer<typeof TemplateIdParam>;
export type MilestoneIndexParamType = z.infer<typeof MilestoneIndexParam>;
export type MilestoneReleaseParamsType = z.infer<typeof MilestoneReleaseParams>;
export type CreateTemplateBodyType = z.infer<typeof CreateTemplateBody>;
export type UpdateTemplateBodyType = z.infer<typeof UpdateTemplateBody>;
export type TemplateOwnerQueryType = z.infer<typeof TemplateOwnerQuery>;
export type CreateContractBodyType = z.infer<typeof CreateContractBody>;
export type DepositBodyType = z.infer<typeof DepositBody>;
export type DisputeBodyType = z.infer<typeof DisputeBody>;
export type ResolveBodyType = z.infer<typeof ResolveBody>;
export type RateBodyType = z.infer<typeof RateBody>;
export type CancelBodyType = z.infer<typeof CancelBody>;
export type ListQueryType = z.infer<typeof ListQuery>;
export type ReputationAddressParamType = z.infer<typeof ReputationAddressParam>;