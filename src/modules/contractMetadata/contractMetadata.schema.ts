import { z } from 'zod';
import { registry } from '../../docs/openapi-registry';
import { paginationQuerySchema as basePaginationQuerySchema } from '../../utils/pagination';

export const createContractMetadataSchema = z.object({
  key: z.string()
    .min(1, 'Key is required')
    .max(255, 'Key must be 255 characters or less')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Key can only contain alphanumeric characters, underscores, and hyphens')
    .openapi({ example: 'payment_status' }),
  value: z.string()
    .min(1, 'Value is required')
    .max(10000, 'Value must be 10000 characters or less')
    .openapi({ example: 'pending' }),
  data_type: z.enum(['string', 'number', 'boolean', 'json'])
    .default('string')
    .optional()
    .openapi({ example: 'string' }),
  is_sensitive: z.boolean()
    .default(false)
    .optional()
    .openapi({ example: false })
});

registry.register('CreateContractMetadata', createContractMetadataSchema);

export const updateContractMetadataSchema = z.object({
  value: z.string()
    .min(1, 'Value is required')
    .max(10000, 'Value must be 10000 characters or less')
    .optional()
    .openapi({ example: 'completed' }),
  is_sensitive: z.boolean()
    .optional()
    .openapi({ example: false })
}).strict();

registry.register('UpdateContractMetadata', updateContractMetadataSchema);

export const contractIdParamsSchema = z.object({
  contractId: z.string().uuid('Invalid contract ID format').openapi({ example: '123e4567-e89b-12d3-a456-426614174000' })
});

export const metadataIdParamsSchema = z.object({
  contractId: z.string().uuid('Invalid contract ID format').openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
  id: z.string().uuid('Invalid metadata ID format').openapi({ example: '123e4567-e89b-12d3-a456-426614174001' })
});

export const paginationQuerySchema = basePaginationQuerySchema.extend({
  key: z.string().optional(),
  data_type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
});
