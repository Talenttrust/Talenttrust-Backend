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
