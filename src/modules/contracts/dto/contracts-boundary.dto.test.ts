import type { Contract } from '../../../db/types';
import {
  CreateContractRequestDto,
  UpdateContractRequestDto,
  fromContractResponseDto,
  toContractResponseDto,
  toCreateContractDto,
  toUpdateContractDto,
} from './contracts-boundary.dto';

describe('contracts boundary DTO mappings', () => {
  it('round-trips a contract without changing its public fields', () => {
    const contract: Contract = {
      id: 'contract-1',
      title: 'Build a typed boundary',
      clientId: 'client-1',
      freelancerId: 'freelancer-1',
      amount: 2_000,
      status: 'active',
      createdAt: '2026-07-25T10:00:00.000Z',
      version: 3,
    };

    expect(fromContractResponseDto(toContractResponseDto(contract))).toEqual(
      contract,
    );
  });

  it('maps a complete create request and copies nested milestones', () => {
    const request: CreateContractRequestDto = {
      title: 'Build a typed boundary',
      description: 'Introduce explicit transport types.',
      clientId: 'client-1',
      freelancerId: 'freelancer-1',
      budget: 2_000,
      deadline: '2026-08-25T10:00:00.000Z',
      status: 'active',
      terms: 'Payment after review.',
      milestones: [
        {
          title: 'DTO layer',
          description: 'Add DTOs and mappers.',
          amount: 2_000,
          completed: false,
        },
      ],
    };

    const mapped = toCreateContractDto(request);

    expect(mapped).toEqual(request);
    expect(mapped.milestones).not.toBe(request.milestones);
    expect(mapped.milestones?.[0]).not.toBe(request.milestones?.[0]);
  });

  it('omits missing optional fields from a create request', () => {
    const request: CreateContractRequestDto = {
      title: 'Build a typed boundary',
      description: 'Introduce explicit transport types.',
      clientId: 'client-1',
      budget: 2_000,
    };

    expect(toCreateContractDto(request)).toEqual(request);
  });

  it('preserves nulls and zero values in an update request', () => {
    const request: UpdateContractRequestDto = {
      version: 0,
      freelancerId: null,
      deadline: null,
      terms: null,
      budget: 1,
    };

    expect(toUpdateContractDto(request)).toEqual(request);
  });

  it('maps every optional update field and copies nested milestones', () => {
    const request: UpdateContractRequestDto = {
      version: 2,
      title: 'Updated contract title',
      description: 'Updated contract description.',
      freelancerId: 'freelancer-2',
      clientId: 'client-2',
      budget: 3_000,
      deadline: '2026-09-25T10:00:00.000Z',
      status: 'completed',
      terms: 'Updated terms.',
      milestones: [
        {
          title: 'Finish DTO layer',
          description: 'Complete the boundary mappings.',
          amount: 3_000,
          completed: true,
        },
      ],
    };

    const mapped = toUpdateContractDto(request);

    expect(mapped).toEqual(request);
    expect(mapped.milestones).not.toBe(request.milestones);
    expect(mapped.milestones?.[0]).not.toBe(request.milestones?.[0]);
  });

  it('omits every missing optional update field', () => {
    expect(toUpdateContractDto({ version: 4 })).toEqual({ version: 4 });
  });
});
