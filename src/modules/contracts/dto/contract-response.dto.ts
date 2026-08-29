import { z, ZodTypeAny } from "zod";
import { registry } from "../../../docs/openapi-registry";
import { ResponseContractError } from "../../../errors/appError";

// ─── Response schemas ──────────────────────────────────────────────────────
//
// These mirror the transport DTOs in `contracts-boundary.dto.ts` and the
// service-layer return shapes in `contracts.service.ts`. They are validated
// at the boundary (see `assertResponseSchema` below) immediately before a
// payload is handed to `ok()`, so a persistence or service bug that drifts
// the outgoing shape away from the public contract fails loudly (500) rather
// than silently changing the API's public surface.

const contractStatusEnum = z.enum([
  "draft",
  "active",
  "completed",
  "cancelled",
  "disputed",
]);

/** Response shape for a single contract, as returned by create/update/get. */
export const contractResponseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    clientId: z.string(),
    freelancerId: z.string(),
    amount: z.number(),
    status: contractStatusEnum,
    createdAt: z.string(),
    version: z.number().int(),
    deletedAt: z.string().nullable().optional(),
  })
  .strict();

/** Response shape for GET /api/v1/contracts (list of contracts). */
export const contractListResponseSchema = z.array(contractResponseSchema);

/** Response shape for GET /api/v1/contracts/stats. */
export const contractStatsResponseSchema = z
  .object({
    total: z.number().int().nonnegative(),
    totalBudget: z.number(),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

/** Response shape for GET /api/v1/contracts/bounds. */
export const contractBoundsResponseSchema = z
  .object({
    maxMilestonesPerContract: z.number().int().positive(),
    maxContractAmountStroops: z.number().positive(),
  })
  .strict();

/** Response shape for DELETE /api/v1/contracts/:id. */
export const deleteContractResponseSchema = z
  .object({
    message: z.string(),
  })
  .strict();

registry.register("ContractResponse", contractResponseSchema);

export type ContractResponse = z.infer<typeof contractResponseSchema>;
export type ContractStatsResponse = z.infer<typeof contractStatsResponseSchema>;
export type ContractBoundsResponse = z.infer<
  typeof contractBoundsResponseSchema
>;
export type DeleteContractResponse = z.infer<
  typeof deleteContractResponseSchema
>;

// ─── Boundary assertion helper ─────────────────────────────────────────────

/**
 * Parses `data` against `schema`, returning the validated value.
 *
 * Throws a {@link ResponseContractError} (mapped to a 500 with no internal
 * detail exposed to the client) when `data` does not match `schema`. Callers
 * pass a short `context` label (e.g. `'Contract'`) used only in the
 * server-side log message.
 */
export function assertResponseSchema<T>(
  schema: ZodTypeAny,
  data: unknown,
  context: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
      .join("; ");
    throw new ResponseContractError(
      `${context} response failed schema validation: ${detail}`,
    );
  }
  return result.data as T;
}
