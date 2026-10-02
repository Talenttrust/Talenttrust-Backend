/**
 * @file milestone.dto.test.ts
 * @description Unit tests for the milestones typed DTO layer.
 *
 * Coverage:
 *   ✓ toCreateMilestoneInput      — all fields, optional-only, unknown-key isolation
 *   ✓ toListMilestonesOptions     — string coercions, edge cases
 *   ✓ toMilestoneResponseDto      — Date serialisation, deadline presence/absence,
 *                                   deletedAt null/present, description defaults
 *   ✓ toListMilestonesResponseDto — empty list, populated list, total count
 *   ✓ toSingleMilestoneResponseDto— with message, without message
 *   ✓ fromMilestoneResponseDto    — ISO→Date, deadline optional, deletedAt null/string
 *   ✓ Round-trip fidelity         — toMilestoneResponseDto ∘ fromMilestoneResponseDto
 *   ✓ Isolation                   — mutations to input objects do not affect output
 */

import type { MilestoneRecord } from '../../../services/milestones.service';
import {
  toCreateMilestoneInput,
  toListMilestonesOptions,
  toMilestoneResponseDto,
  toListMilestonesResponseDto,
  toSingleMilestoneResponseDto,
  fromMilestoneResponseDto,
  type CreateMilestoneRequestDto,
  type ListMilestonesQueryDto,
  type MilestoneResponseDto,
} from './milestone.dto';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CREATED_AT = new Date('2026-07-01T09:00:00.000Z');
const UPDATED_AT = new Date('2026-07-10T12:00:00.000Z');
const DELETED_AT = new Date('2026-07-15T08:30:00.000Z');

/** A fully-populated active (not-deleted) MilestoneRecord. */
function makeRecord(overrides: Partial<MilestoneRecord> = {}): MilestoneRecord {
  return {
    id: 'ms-uuid-1',
    contractId: 'contract-uuid-1',
    title: 'Design phase',
    description: 'Complete UI wireframes',
    amount: 2_500,
    deadline: '2026-08-01T00:00:00.000Z',
    completed: false,
    createdAt: new Date(CREATED_AT),
    updatedAt: new Date(UPDATED_AT),
    deletedAt: null,
    ...overrides,
  };
}

/** A fully-populated MilestoneResponseDto (active milestone). */
function makeResponseDto(overrides: Partial<MilestoneResponseDto> = {}): MilestoneResponseDto {
  return {
    id: 'ms-uuid-1',
    contractId: 'contract-uuid-1',
    title: 'Design phase',
    description: 'Complete UI wireframes',
    amount: 2_500,
    deadline: '2026-08-01T00:00:00.000Z',
    completed: false,
    createdAt: CREATED_AT.toISOString(),
    updatedAt: UPDATED_AT.toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

// ─── toCreateMilestoneInput ───────────────────────────────────────────────────

describe('toCreateMilestoneInput', () => {
  it('maps all fields when all are supplied', () => {
    const dto: CreateMilestoneRequestDto = {
      title: 'Phase 1',
      description: 'Kickoff tasks',
      amount: 1_000,
      deadline: '2026-09-01T00:00:00.000Z',
      completed: true,
    };

    expect(toCreateMilestoneInput(dto)).toEqual({
      title: 'Phase 1',
      description: 'Kickoff tasks',
      amount: 1_000,
      deadline: '2026-09-01T00:00:00.000Z',
      completed: true,
    });
  });

  it('maps only required fields when all optional fields are absent', () => {
    const dto: CreateMilestoneRequestDto = { title: 'Minimal', amount: 500 };
    const input = toCreateMilestoneInput(dto);
    expect(input.title).toBe('Minimal');
    expect(input.amount).toBe(500);
    expect(input).not.toHaveProperty('description');
    expect(input).not.toHaveProperty('deadline');
    expect(input).not.toHaveProperty('completed');
  });

  it('includes description when provided', () => {
    const dto: CreateMilestoneRequestDto = { title: 'A', amount: 1, description: 'Desc' };
    expect(toCreateMilestoneInput(dto)).toHaveProperty('description', 'Desc');
  });

  it('includes deadline when provided', () => {
    const dto: CreateMilestoneRequestDto = { title: 'A', amount: 1, deadline: '2026-12-31T00:00:00.000Z' };
    expect(toCreateMilestoneInput(dto)).toHaveProperty('deadline', '2026-12-31T00:00:00.000Z');
  });

  it('includes completed=false when explicitly supplied', () => {
    const dto: CreateMilestoneRequestDto = { title: 'A', amount: 1, completed: false };
    expect(toCreateMilestoneInput(dto)).toHaveProperty('completed', false);
  });

  it('includes completed=true when explicitly supplied', () => {
    const dto: CreateMilestoneRequestDto = { title: 'A', amount: 1, completed: true };
    expect(toCreateMilestoneInput(dto)).toHaveProperty('completed', true);
  });

  it('does not carry unknown keys from the DTO to the service input', () => {
    // TypeScript prevents this at compile time; this test guards against runtime leakage
    const dto = { title: 'A', amount: 1, extraField: 'should-be-dropped' } as unknown as CreateMilestoneRequestDto;
    const input = toCreateMilestoneInput(dto);
    expect(input).not.toHaveProperty('extraField');
  });

  it('preserves a zero-length description (empty string)', () => {
    const dto: CreateMilestoneRequestDto = { title: 'A', amount: 1, description: '' };
    expect(toCreateMilestoneInput(dto)).toHaveProperty('description', '');
  });

  it('preserves a maximum-value amount', () => {
    const dto: CreateMilestoneRequestDto = { title: 'A', amount: 100_000_000_000_000 };
    expect(toCreateMilestoneInput(dto).amount).toBe(100_000_000_000_000);
  });
});

// ─── toListMilestonesOptions ──────────────────────────────────────────────────

describe('toListMilestonesOptions', () => {
  it('returns includeDeleted=true when query is "true"', () => {
    const dto: ListMilestonesQueryDto = { includeDeleted: 'true' };
    expect(toListMilestonesOptions(dto)).toEqual({ includeDeleted: true });
  });

  it('returns includeDeleted=false when query is "false"', () => {
    const dto: ListMilestonesQueryDto = { includeDeleted: 'false' };
    expect(toListMilestonesOptions(dto)).toEqual({ includeDeleted: false });
  });

  it('returns includeDeleted=false when query is absent', () => {
    const dto: ListMilestonesQueryDto = {};
    expect(toListMilestonesOptions(dto)).toEqual({ includeDeleted: false });
  });

  it('returns includeDeleted=false when query is an unexpected string', () => {
    const dto: ListMilestonesQueryDto = { includeDeleted: '1' };
    expect(toListMilestonesOptions(dto)).toEqual({ includeDeleted: false });
  });

  it('returns includeDeleted=false when query is empty string', () => {
    const dto: ListMilestonesQueryDto = { includeDeleted: '' };
    expect(toListMilestonesOptions(dto)).toEqual({ includeDeleted: false });
  });

  it('returns includeDeleted=false when query is "TRUE" (case-sensitive guard)', () => {
    const dto: ListMilestonesQueryDto = { includeDeleted: 'TRUE' };
    expect(toListMilestonesOptions(dto)).toEqual({ includeDeleted: false });
  });
});

// ─── toMilestoneResponseDto ───────────────────────────────────────────────────

describe('toMilestoneResponseDto', () => {
  it('maps all required fields from a fully-populated active record', () => {
    const record = makeRecord();
    const dto = toMilestoneResponseDto(record);

    expect(dto.id).toBe('ms-uuid-1');
    expect(dto.contractId).toBe('contract-uuid-1');
    expect(dto.title).toBe('Design phase');
    expect(dto.description).toBe('Complete UI wireframes');
    expect(dto.amount).toBe(2_500);
    expect(dto.completed).toBe(false);
  });

  it('serialises createdAt Date to ISO-8601 string', () => {
    const record = makeRecord();
    const dto = toMilestoneResponseDto(record);
    expect(dto.createdAt).toBe(CREATED_AT.toISOString());
    expect(typeof dto.createdAt).toBe('string');
  });

  it('serialises updatedAt Date to ISO-8601 string', () => {
    const record = makeRecord();
    const dto = toMilestoneResponseDto(record);
    expect(dto.updatedAt).toBe(UPDATED_AT.toISOString());
    expect(typeof dto.updatedAt).toBe('string');
  });

  it('serialises a non-null deletedAt Date to ISO-8601 string', () => {
    const record = makeRecord({ deletedAt: new Date(DELETED_AT) });
    const dto = toMilestoneResponseDto(record);
    expect(dto.deletedAt).toBe(DELETED_AT.toISOString());
    expect(typeof dto.deletedAt).toBe('string');
  });

  it('maps deletedAt=null to null (not undefined)', () => {
    const record = makeRecord({ deletedAt: null });
    const dto = toMilestoneResponseDto(record);
    expect(dto.deletedAt).toBeNull();
  });

  it('maps deletedAt=undefined to null', () => {
    const record = makeRecord();
    delete record.deletedAt;
    const dto = toMilestoneResponseDto(record);
    expect(dto.deletedAt).toBeNull();
  });

  it('includes deadline when record has one', () => {
    const record = makeRecord({ deadline: '2026-08-01T00:00:00.000Z' });
    const dto = toMilestoneResponseDto(record);
    expect(dto.deadline).toBe('2026-08-01T00:00:00.000Z');
  });

  it('omits deadline when record has none', () => {
    const record = makeRecord();
    delete record.deadline;
    const dto = toMilestoneResponseDto(record);
    expect(dto).not.toHaveProperty('deadline');
  });

  it('maps completed=true correctly', () => {
    const record = makeRecord({ completed: true });
    expect(toMilestoneResponseDto(record).completed).toBe(true);
  });

  it('produces a plain object (not a Date instance)', () => {
    const dto = toMilestoneResponseDto(makeRecord());
    expect(dto.createdAt).not.toBeInstanceOf(Date);
    expect(dto.updatedAt).not.toBeInstanceOf(Date);
    expect(dto.deletedAt).not.toBeInstanceOf(Date);
  });

  it('does not mutate the source record', () => {
    const record = makeRecord();
    const originalCreatedAt = record.createdAt;
    toMilestoneResponseDto(record);
    expect(record.createdAt).toBe(originalCreatedAt);
  });

  it('preserves a zero-length description', () => {
    const record = makeRecord({ description: '' });
    expect(toMilestoneResponseDto(record).description).toBe('');
  });
});

// ─── toListMilestonesResponseDto ──────────────────────────────────────────────

describe('toListMilestonesResponseDto', () => {
  it('returns total=0 and empty array for an empty list', () => {
    const result = toListMilestonesResponseDto([]);
    expect(result.milestones).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns the correct total for a single-item list', () => {
    const result = toListMilestonesResponseDto([makeRecord()]);
    expect(result.total).toBe(1);
    expect(result.milestones).toHaveLength(1);
  });

  it('returns the correct total for a multi-item list', () => {
    const records = [makeRecord(), makeRecord({ id: 'ms-2', title: 'Phase 2' })];
    const result = toListMilestonesResponseDto(records);
    expect(result.total).toBe(2);
    expect(result.milestones).toHaveLength(2);
  });

  it('maps each record through toMilestoneResponseDto', () => {
    const records = [makeRecord(), makeRecord({ id: 'ms-2', title: 'Phase 2' })];
    const result = toListMilestonesResponseDto(records);
    expect(result.milestones[0].id).toBe('ms-uuid-1');
    expect(result.milestones[1].id).toBe('ms-2');
  });

  it('total always equals milestones.length', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ id: `ms-${i}`, title: `MS ${i}` }),
    );
    const result = toListMilestonesResponseDto(records);
    expect(result.total).toBe(result.milestones.length);
  });

  it('each item in the list has serialised ISO-8601 dates', () => {
    const result = toListMilestonesResponseDto([makeRecord()]);
    expect(typeof result.milestones[0].createdAt).toBe('string');
    expect(typeof result.milestones[0].updatedAt).toBe('string');
  });

  it('does not mutate the input array', () => {
    const records = [makeRecord()];
    const original = [...records];
    toListMilestonesResponseDto(records);
    expect(records).toEqual(original);
  });
});

// ─── toSingleMilestoneResponseDto ─────────────────────────────────────────────

describe('toSingleMilestoneResponseDto', () => {
  it('wraps the record in a milestone field', () => {
    const record = makeRecord();
    const result = toSingleMilestoneResponseDto(record);
    expect(result).toHaveProperty('milestone');
    expect(result.milestone.id).toBe(record.id);
  });

  it('omits message when not supplied', () => {
    const result = toSingleMilestoneResponseDto(makeRecord());
    expect(result).not.toHaveProperty('message');
  });

  it('includes message when supplied', () => {
    const result = toSingleMilestoneResponseDto(makeRecord(), 'Milestone ms-uuid-1 soft-deleted');
    expect(result.message).toBe('Milestone ms-uuid-1 soft-deleted');
  });

  it('includes message when supplied as empty string', () => {
    const result = toSingleMilestoneResponseDto(makeRecord(), '');
    expect(result).toHaveProperty('message', '');
  });

  it('milestone field contains a properly serialised DTO', () => {
    const record = makeRecord();
    const result = toSingleMilestoneResponseDto(record);
    expect(typeof result.milestone.createdAt).toBe('string');
    expect(result.milestone.deletedAt).toBeNull();
  });

  it('soft-deleted record carries a non-null deletedAt in the wrapped DTO', () => {
    const record = makeRecord({ deletedAt: new Date(DELETED_AT) });
    const result = toSingleMilestoneResponseDto(record, `Milestone ${record.id} soft-deleted`);
    expect(result.milestone.deletedAt).toBe(DELETED_AT.toISOString());
    expect(result.message).toContain('soft-deleted');
  });

  it('restored record has deletedAt=null in the wrapped DTO', () => {
    const record = makeRecord({ deletedAt: null });
    const result = toSingleMilestoneResponseDto(record, `Milestone ${record.id} restored`);
    expect(result.milestone.deletedAt).toBeNull();
  });
});

// ─── fromMilestoneResponseDto ─────────────────────────────────────────────────

describe('fromMilestoneResponseDto', () => {
  it('maps a complete DTO back to a MilestoneRecord', () => {
    const dto = makeResponseDto();
    const record = fromMilestoneResponseDto(dto);

    expect(record.id).toBe('ms-uuid-1');
    expect(record.contractId).toBe('contract-uuid-1');
    expect(record.title).toBe('Design phase');
    expect(record.description).toBe('Complete UI wireframes');
    expect(record.amount).toBe(2_500);
    expect(record.completed).toBe(false);
  });

  it('parses createdAt ISO string back to a Date', () => {
    const record = fromMilestoneResponseDto(makeResponseDto());
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.createdAt.toISOString()).toBe(CREATED_AT.toISOString());
  });

  it('parses updatedAt ISO string back to a Date', () => {
    const record = fromMilestoneResponseDto(makeResponseDto());
    expect(record.updatedAt).toBeInstanceOf(Date);
    expect(record.updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());
  });

  it('maps deletedAt=null to null (not undefined)', () => {
    const record = fromMilestoneResponseDto(makeResponseDto({ deletedAt: null }));
    expect(record.deletedAt).toBeNull();
  });

  it('parses a non-null deletedAt ISO string back to a Date', () => {
    const record = fromMilestoneResponseDto(
      makeResponseDto({ deletedAt: DELETED_AT.toISOString() }),
    );
    expect(record.deletedAt).toBeInstanceOf(Date);
    expect((record.deletedAt as Date).toISOString()).toBe(DELETED_AT.toISOString());
  });

  it('maps deadline when present in DTO', () => {
    const record = fromMilestoneResponseDto(makeResponseDto({ deadline: '2026-08-01T00:00:00.000Z' }));
    expect(record.deadline).toBe('2026-08-01T00:00:00.000Z');
  });

  it('omits deadline when absent in DTO', () => {
    const dto = makeResponseDto();
    delete dto.deadline;
    const record = fromMilestoneResponseDto(dto);
    expect(record).not.toHaveProperty('deadline');
  });
});

// ─── Round-trip fidelity ──────────────────────────────────────────────────────

describe('round-trip: toMilestoneResponseDto → fromMilestoneResponseDto', () => {
  it('round-trips a fully-populated active record without data loss', () => {
    const original = makeRecord();
    const dto = toMilestoneResponseDto(original);
    const restored = fromMilestoneResponseDto(dto);

    // Compare field-by-field (Dates → use toISOString for comparison)
    expect(restored.id).toBe(original.id);
    expect(restored.contractId).toBe(original.contractId);
    expect(restored.title).toBe(original.title);
    expect(restored.description).toBe(original.description);
    expect(restored.amount).toBe(original.amount);
    expect(restored.completed).toBe(original.completed);
    expect(restored.deadline).toBe(original.deadline);
    expect(restored.createdAt.toISOString()).toBe(original.createdAt.toISOString());
    expect(restored.updatedAt.toISOString()).toBe(original.updatedAt.toISOString());
    expect(restored.deletedAt).toBeNull();
  });

  it('round-trips a soft-deleted record preserving deletedAt', () => {
    const original = makeRecord({ deletedAt: new Date(DELETED_AT) });
    const dto = toMilestoneResponseDto(original);
    const restored = fromMilestoneResponseDto(dto);

    expect((restored.deletedAt as Date).toISOString()).toBe(DELETED_AT.toISOString());
  });

  it('round-trips a record without a deadline preserving the absence', () => {
    const original = makeRecord();
    delete original.deadline;
    const dto = toMilestoneResponseDto(original);
    const restored = fromMilestoneResponseDto(dto);

    expect(restored).not.toHaveProperty('deadline');
  });

  it('round-trips a record with completed=true', () => {
    const original = makeRecord({ completed: true });
    const dto = toMilestoneResponseDto(original);
    const restored = fromMilestoneResponseDto(dto);

    expect(restored.completed).toBe(true);
  });

  it('round-trips a record with an empty description', () => {
    const original = makeRecord({ description: '' });
    const dto = toMilestoneResponseDto(original);
    const restored = fromMilestoneResponseDto(dto);

    expect(restored.description).toBe('');
  });
});

// ─── Object isolation ─────────────────────────────────────────────────────────

describe('object isolation — mutations do not bleed across boundaries', () => {
  it('mutating the DTO after toMilestoneResponseDto does not affect the source record', () => {
    const record = makeRecord();
    const dto = toMilestoneResponseDto(record);
    (dto as { title: string }).title = 'mutated';
    expect(record.title).toBe('Design phase');
  });

  it('mutating the source record after toMilestoneResponseDto does not affect the DTO', () => {
    const record = makeRecord();
    const dto = toMilestoneResponseDto(record);
    record.title = 'mutated';
    expect(dto.title).toBe('Design phase');
  });

  it('mutating the source record after fromMilestoneResponseDto does not affect the restored record', () => {
    const dto = makeResponseDto();
    const record = fromMilestoneResponseDto(dto);
    dto.title = 'mutated';
    expect(record.title).toBe('Design phase');
  });

  it('milestones array in toListMilestonesResponseDto is a new array', () => {
    const records = [makeRecord()];
    const result = toListMilestonesResponseDto(records);
    records.push(makeRecord({ id: 'new' }));
    expect(result.milestones).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

// ─── Missing optional fields ──────────────────────────────────────────────────

describe('missing optional fields are handled gracefully', () => {
  it('toCreateMilestoneInput with only required fields produces a valid service input', () => {
    const dto: CreateMilestoneRequestDto = { title: 'Required-only', amount: 42 };
    const input = toCreateMilestoneInput(dto);
    expect(input.title).toBe('Required-only');
    expect(input.amount).toBe(42);
  });

  it('toListMilestonesOptions with an empty DTO produces includeDeleted=false', () => {
    expect(toListMilestonesOptions({})).toEqual({ includeDeleted: false });
  });

  it('toSingleMilestoneResponseDto without message omits the message key', () => {
    const result = toSingleMilestoneResponseDto(makeRecord());
    expect(Object.prototype.hasOwnProperty.call(result, 'message')).toBe(false);
  });
});
