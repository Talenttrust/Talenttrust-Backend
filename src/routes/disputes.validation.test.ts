import {
  createDisputeSchema,
  updateDisputeSchema,
  disputeParamsSchema,
  listDisputesQuerySchema,
} from './disputes.validation';

const validUuid = '550e8400-e29b-41d4-a716-446655440000';

describe('createDisputeSchema', () => {
  it('accepts a valid payload', () => {
    const result = createDisputeSchema.safeParse({
      contractId: validUuid,
      reason: 'Deliverable does not match specifications',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a payload with optional raisedBy', () => {
    const result = createDisputeSchema.safeParse({
      contractId: validUuid,
      reason: 'Late delivery',
      raisedBy: validUuid,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.raisedBy).toBe(validUuid);
    }
  });

  it('rejects missing contractId', () => {
    const result = createDisputeSchema.safeParse({
      reason: 'Test reason',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid contractId', () => {
    const result = createDisputeSchema.safeParse({
      contractId: 'not-a-uuid',
      reason: 'Test reason',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing reason', () => {
    const result = createDisputeSchema.safeParse({
      contractId: validUuid,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty reason', () => {
    const result = createDisputeSchema.safeParse({
      contractId: validUuid,
      reason: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects reason exceeding 2000 characters', () => {
    const result = createDisputeSchema.safeParse({
      contractId: validUuid,
      reason: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid raisedBy', () => {
    const result = createDisputeSchema.safeParse({
      contractId: validUuid,
      reason: 'Test reason',
      raisedBy: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object payloads', () => {
    const result = createDisputeSchema.safeParse('nope');
    expect(result.success).toBe(false);
  });

  it('rejects null body', () => {
    const result = createDisputeSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

describe('updateDisputeSchema', () => {
  it('accepts an empty payload (partial update)', () => {
    const result = updateDisputeSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a valid status update', () => {
    const result = updateDisputeSchema.safeParse({
      status: 'resolved',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full update payload', () => {
    const result = updateDisputeSchema.safeParse({
      status: 'cancelled',
      resolution: 'Client agreed to cancel',
      resolvedBy: validUuid,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = updateDisputeSchema.safeParse({
      status: 'invalid_status',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty resolution', () => {
    const result = updateDisputeSchema.safeParse({
      resolution: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects resolution exceeding 2000 characters', () => {
    const result = updateDisputeSchema.safeParse({
      resolution: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid resolvedBy', () => {
    const result = updateDisputeSchema.safeParse({
      resolvedBy: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid status enum values', () => {
    const statuses = ['open', 'resolved', 'cancelled'] as const;
    for (const status of statuses) {
      const result = updateDisputeSchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });
});

describe('disputeParamsSchema', () => {
  it('accepts a valid UUID param', () => {
    const result = disputeParamsSchema.safeParse({ id: validUuid });
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    const result = disputeParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID id', () => {
    const result = disputeParamsSchema.safeParse({ id: '123' });
    expect(result.success).toBe(false);
  });
});

describe('listDisputesQuerySchema', () => {
  it('accepts an empty query (uses defaults)', () => {
    const result = listDisputesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('accepts pagination params', () => {
    const result = listDisputesQuerySchema.safeParse({
      page: '2',
      limit: '50',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(50);
    }
  });

  it('accepts filter params', () => {
    const result = listDisputesQuerySchema.safeParse({
      status: 'open',
      contractId: validUuid,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative page', () => {
    const result = listDisputesQuerySchema.safeParse({
      page: '-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero page', () => {
    const result = listDisputesQuerySchema.safeParse({
      page: '0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects limit exceeding 100', () => {
    const result = listDisputesQuerySchema.safeParse({
      limit: '101',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric page', () => {
    const result = listDisputesQuerySchema.safeParse({
      page: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid contractId in query', () => {
    const result = listDisputesQuerySchema.safeParse({
      contractId: 'bad-id',
    });
    expect(result.success).toBe(false);
  });
});
