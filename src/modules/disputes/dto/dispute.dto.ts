export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'escalated';

export interface CreateDisputeDto {
  contractId?: string;
  reason?: string;
  raisedBy?: string;
}

export interface UpdateDisputeDto {
  status?: string;
  resolution?: string;
  resolvedBy?: string;
  clientRefundAmount?: number;
  freelancerReleaseAmount?: number;
}

/** Payload used by DisputesService.updateDispute / processBatch. */
export interface UpdateDisputePayload {
  status?: DisputeStatus;
  resolution?: string;
  /**
   * Actor performing the status change. Persisted atomically with the
   * transition so every state change is auditable.
   */
  statusChangedBy?: string;
  /**
   * Optimistic-concurrency token: the `version` the caller read. When
   * provided and stale, the update is rejected with `dispute_version_conflict`
   * so concurrent transitions cannot silently overwrite each other.
   */
  expectedVersion?: number;
}

/** Single operation in a batch dispute update. */
export interface BatchDisputeOperation {
  id: string;
  status?: DisputeStatus;
  resolution?: string;
}

export interface DisputeResponseDto {
  id: string;
  status: string;
  contractId?: string;
  reason?: string;
  raisedBy?: string;
  resolution?: string;
  resolvedBy?: string;
  clientRefundAmount?: number;
  freelancerReleaseAmount?: number;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  /** Optimistic-concurrency version (read it before updating). */
  version?: number;
  /** Actor of the last status change. */
  statusChangedBy?: string;
  /** Reason for the last status change. */
  statusChangeReason?: string;
}

export function mapToDisputeResponse(data: any): DisputeResponseDto {
  const response: DisputeResponseDto = {
    id: data?.id,
    status: data?.status || 'open',
  };

  if (data?.contractId !== undefined) response.contractId = data.contractId;
  if (data?.reason !== undefined) response.reason = data.reason;
  if (data?.raisedBy !== undefined) response.raisedBy = data.raisedBy;
  if (data?.resolution !== undefined) response.resolution = data.resolution;
  if (data?.resolvedBy !== undefined) response.resolvedBy = data.resolvedBy;
  if (data?.clientRefundAmount !== undefined) response.clientRefundAmount = data.clientRefundAmount;
  if (data?.freelancerReleaseAmount !== undefined) response.freelancerReleaseAmount = data.freelancerReleaseAmount;
  if (data?.createdAt !== undefined) response.createdAt = data.createdAt;
  if (data?.updatedAt !== undefined) response.updatedAt = data.updatedAt;
  if (data?.deletedAt !== undefined) {
    response.deletedAt =
      data.deletedAt instanceof Date
        ? data.deletedAt.toISOString()
        : data.deletedAt;
  }
  if (data?.version !== undefined) response.version = data.version;
  if (data?.statusChangedBy !== undefined) response.statusChangedBy = data.statusChangedBy;
  if (data?.statusChangeReason !== undefined) response.statusChangeReason = data.statusChangeReason;

  return response;
}

export function mapToCreateDisputeDto(data: any): CreateDisputeDto {
  const dto: CreateDisputeDto = {};
  if (data?.contractId !== undefined) dto.contractId = data.contractId;
  if (data?.reason !== undefined) dto.reason = data.reason;
  if (data?.raisedBy !== undefined) dto.raisedBy = data.raisedBy;
  return dto;
}

export function mapToUpdateDisputeDto(data: any): UpdateDisputeDto {
  const dto: UpdateDisputeDto = {};
  if (data?.status !== undefined) dto.status = data.status;
  if (data?.resolution !== undefined) dto.resolution = data.resolution;
  if (data?.resolvedBy !== undefined) dto.resolvedBy = data.resolvedBy;
  if (data?.clientRefundAmount !== undefined) dto.clientRefundAmount = data.clientRefundAmount;
  if (data?.freelancerReleaseAmount !== undefined) dto.freelancerReleaseAmount = data.freelancerReleaseAmount;
  return dto;
}
