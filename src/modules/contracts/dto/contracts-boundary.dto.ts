import type { Contract, ContractStatus } from "../../../db/types";
import type { CreateContractDto, UpdateContractDto } from "./contract.dto";
import {
  assertResponseSchema,
  contractResponseSchema,
} from "./contract-response.dto";

export interface ContractMilestoneDto {
  title: string;
  description: string;
  amount: number;
  deadline?: string;
  completed: boolean;
}

export interface CreateContractRequestDto {
  title: string;
  description: string;
  freelancerId?: string;
  clientId: string;
  budget: number;
  deadline?: string;
  status?: ContractStatus;
  terms?: string;
  milestones?: ContractMilestoneDto[];
}

export interface UpdateContractRequestDto {
  version: number;
  title?: string;
  description?: string;
  freelancerId?: string | null;
  clientId?: string;
  budget?: number;
  deadline?: string | null;
  status?: ContractStatus;
  terms?: string | null;
  milestones?: ContractMilestoneDto[];
}

export interface ContractResponseDto {
  id: string;
  title: string;
  clientId: string;
  freelancerId: string;
  amount: number;
  status: ContractStatus;
  createdAt: string;
  version: number;
  deletedAt?: string | null;
}

/**
 * Maps the validated HTTP create payload into the service-layer input.
 * Properties are copied explicitly so transport-only fields cannot leak inward.
 */
export function toCreateContractDto(
  request: CreateContractRequestDto,
): CreateContractDto {
  return {
    title: request.title,
    description: request.description,
    clientId: request.clientId,
    budget: request.budget,
    ...(request.freelancerId !== undefined && {
      freelancerId: request.freelancerId,
    }),
    ...(request.deadline !== undefined && { deadline: request.deadline }),
    ...(request.status !== undefined && { status: request.status }),
    ...(request.terms !== undefined && { terms: request.terms }),
    ...(request.milestones !== undefined && {
      milestones: request.milestones.map((milestone) => ({ ...milestone })),
    }),
  };
}

/**
 * Maps the validated HTTP patch payload into the service-layer input while
 * retaining explicit nulls used to clear nullable fields.
 */
export function toUpdateContractDto(
  request: UpdateContractRequestDto,
): UpdateContractDto {
  return {
    version: request.version,
    ...(request.title !== undefined && { title: request.title }),
    ...(request.description !== undefined && {
      description: request.description,
    }),
    ...(request.freelancerId !== undefined && {
      freelancerId: request.freelancerId,
    }),
    ...(request.clientId !== undefined && { clientId: request.clientId }),
    ...(request.budget !== undefined && { budget: request.budget }),
    ...(request.deadline !== undefined && { deadline: request.deadline }),
    ...(request.status !== undefined && { status: request.status }),
    ...(request.terms !== undefined && { terms: request.terms }),
    ...(request.milestones !== undefined && {
      milestones: request.milestones.map((milestone) => ({ ...milestone })),
    }),
  };
}

/**
 * Maps a persistence model into the stable public contract representation.
 *
 * The mapped payload is validated against `contractResponseSchema` before
 * being returned, so a persistence-layer bug that drifts the domain shape
 * away from the public contract fails as a structured `response_contract_error`
 * (500) instead of silently changing the API's outgoing shape.
 */
export function toContractResponseDto(contract: Contract): ContractResponseDto {
  const createdAtStr =
    contract.createdAt instanceof Date
      ? contract.createdAt.toISOString()
      : typeof contract.createdAt === "string"
        ? contract.createdAt
        : new Date(contract.createdAt ?? Date.now()).toISOString();

  return assertResponseSchema<ContractResponseDto>(
    contractResponseSchema,
    {
      id: contract.id,
      title: contract.title,
      clientId: contract.clientId,
      freelancerId: contract.freelancerId,
      amount: contract.amount,
      status: contract.status,
      createdAt: createdAtStr,
      version: contract.version,
      deletedAt: contract.deletedAt ?? null,
    },
    "Contract",
  );
}

/**
 * Converts the public representation back to the domain shape. This is useful
 * for adapters that hydrate contracts from another contracts API.
 */
export function fromContractResponseDto(dto: ContractResponseDto): Contract {
  return {
    id: dto.id,
    title: dto.title,
    clientId: dto.clientId,
    freelancerId: dto.freelancerId,
    amount: dto.amount,
    status: dto.status,
    createdAt: dto.createdAt,
    version: dto.version,
    deletedAt: dto.deletedAt ?? null,
  };
}

// ─── Bulk milestones types ────────────────────────────────────────────────────

export interface BulkMilestoneOperationResult {
  index: number;
  status: "success" | "error";
  contractId?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface BulkMilestonesResponseDto {
  results: BulkMilestoneOperationResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };
}
