import {
  webhookTriggerDataSchema,
  webhookEventTypeSchema,
  webhookCorrelationIdSchema,
  webhookSendPayloadSchema,
  webhookDeliveryPayloadSchema,
  webhookDeliveryResultSchema,
  webhookDLQEntrySchema,
  webhookDeliveryProviderSchema,
  webhookDeliveryBodySchema,
} from './webhook-payload.dto';

// ---------------------------------------------------------------------------
// webhookEventTypeSchema
// ---------------------------------------------------------------------------

describe('webhookEventTypeSchema', () => {
  it('accepts valid event type strings', () => {
    expect(webhookEventTypeSchema.safeParse('contract.created').success).toBe(true);
    expect(webhookEventTypeSchema.safeParse('escrow.released').success).toBe(true);
    expect(webhookEventTypeSchema.safeParse('a').success).toBe(true);
    expect(webhookEventTypeSchema.safeParse('x'.repeat(200)).success).toBe(true);
  });

  it('rejects empty event type', () => {
    const result = webhookEventTypeSchema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('must not be empty');
    }
  });

  it('rejects event type exceeding max length', () => {
    const result = webhookEventTypeSchema.safeParse('x'.repeat(201));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('200');
    }
  });

  it('rejects non-string event type', () => {
    expect(webhookEventTypeSchema.safeParse(123).success).toBe(false);
    expect(webhookEventTypeSchema.safeParse(null).success).toBe(false);
    expect(webhookEventTypeSchema.safeParse(undefined).success).toBe(false);
    expect(webhookEventTypeSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookTriggerDataSchema
// ---------------------------------------------------------------------------

describe('webhookTriggerDataSchema', () => {
  it('accepts a plain object', () => {
    expect(webhookTriggerDataSchema.safeParse({ event: 'test', data: { id: '123' } }).success).toBe(true);
    expect(webhookTriggerDataSchema.safeParse({}).success).toBe(true);
    expect(webhookTriggerDataSchema.safeParse({ nested: { deep: { value: 42 } } }).success).toBe(true);
  });

  it('rejects arrays', () => {
    const result = webhookTriggerDataSchema.safeParse([1, 2, 3]);
    expect(result.success).toBe(false);
    // Zod's record() returns 'Expected object, received array' for arrays
    // (the custom 'plain object' refine message only triggers for class instances)
  });

  it('rejects null', () => {
    const result = webhookTriggerDataSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects primitives', () => {
    expect(webhookTriggerDataSchema.safeParse('string').success).toBe(false);
    expect(webhookTriggerDataSchema.safeParse(42).success).toBe(false);
    expect(webhookTriggerDataSchema.safeParse(true).success).toBe(false);
  });

  it('rejects undefined', () => {
    expect(webhookTriggerDataSchema.safeParse(undefined).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookCorrelationIdSchema
// ---------------------------------------------------------------------------

describe('webhookCorrelationIdSchema', () => {
  it('accepts valid correlation IDs', () => {
    expect(webhookCorrelationIdSchema.safeParse('trace-abc-123').success).toBe(true);
    expect(webhookCorrelationIdSchema.safeParse('trace.abc.123').success).toBe(true);
    expect(webhookCorrelationIdSchema.safeParse('trace_abc_123').success).toBe(true);
    expect(webhookCorrelationIdSchema.safeParse('TraceABC').success).toBe(true);
  });

  it('accepts undefined (optional field)', () => {
    expect(webhookCorrelationIdSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects correlation IDs exceeding 256 chars', () => {
    const result = webhookCorrelationIdSchema.safeParse('a'.repeat(257));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('256');
    }
  });

  it('rejects correlation IDs with unsafe characters', () => {
    const result = webhookCorrelationIdSchema.safeParse('trace\nX-Injected: true');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('alphanumeric');
    }
  });

  it('rejects correlation IDs with spaces', () => {
    const result = webhookCorrelationIdSchema.safeParse('trace abc');
    expect(result.success).toBe(false);
  });

  it('rejects correlation IDs with angle brackets', () => {
    const result = webhookCorrelationIdSchema.safeParse('trace<script>');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookDeliveryProviderSchema
// ---------------------------------------------------------------------------

describe('webhookDeliveryProviderSchema', () => {
  it('accepts valid provider names', () => {
    expect(webhookDeliveryProviderSchema.safeParse('stripe').success).toBe(true);
    expect(webhookDeliveryProviderSchema.safeParse('github').success).toBe(true);
    expect(webhookDeliveryProviderSchema.safeParse('generic').success).toBe(true);
  });

  it('rejects empty provider', () => {
    const result = webhookDeliveryProviderSchema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('must not be empty');
    }
  });

  it('rejects non-string provider', () => {
    expect(webhookDeliveryProviderSchema.safeParse(null).success).toBe(false);
    expect(webhookDeliveryProviderSchema.safeParse(123).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookDeliveryBodySchema
// ---------------------------------------------------------------------------

describe('webhookDeliveryBodySchema', () => {
  it('accepts a plain object', () => {
    expect(webhookDeliveryBodySchema.safeParse({ event: 'payment.succeeded' }).success).toBe(true);
    expect(webhookDeliveryBodySchema.safeParse({}).success).toBe(true);
  });

  it('rejects arrays', () => {
    const result = webhookDeliveryBodySchema.safeParse([1, 2, 3]);
    expect(result.success).toBe(false);
    // Zod's record() rejects arrays with its own message;
    // the custom 'plain object' refine only fires for class instances
  });

  it('rejects null', () => {
    expect(webhookDeliveryBodySchema.safeParse(null).success).toBe(false);
  });

  it('rejects primitives', () => {
    expect(webhookDeliveryBodySchema.safeParse('string').success).toBe(false);
    expect(webhookDeliveryBodySchema.safeParse(42).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookDeliveryPayloadSchema
// ---------------------------------------------------------------------------

describe('webhookDeliveryPayloadSchema', () => {
  const validPayload = {
    provider: 'stripe',
    url: 'https://example.com/webhook',
    body: { event: 'payment.succeeded', amount: 100 },
  };

  it('accepts a valid delivery payload', () => {
    expect(webhookDeliveryPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('rejects missing provider', () => {
    const { provider: _provider, ...rest } = validPayload;
    expect(webhookDeliveryPayloadSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects empty provider', () => {
    expect(webhookDeliveryPayloadSchema.safeParse({ ...validPayload, provider: '' }).success).toBe(false);
  });

  it('rejects invalid URL', () => {
    expect(webhookDeliveryPayloadSchema.safeParse({ ...validPayload, url: 'not-a-url' }).success).toBe(false);
  });

  it('rejects empty URL', () => {
    const result = webhookDeliveryPayloadSchema.safeParse({ ...validPayload, url: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(webhookDeliveryPayloadSchema.safeParse({ ...validPayload, body: 'string' }).success).toBe(false);
    expect(webhookDeliveryPayloadSchema.safeParse({ ...validPayload, body: null }).success).toBe(false);
    expect(webhookDeliveryPayloadSchema.safeParse({ ...validPayload, body: [1, 2, 3] }).success).toBe(false);
  });

  it('rejects missing body', () => {
    const { body: _body, ...rest } = validPayload;
    expect(webhookDeliveryPayloadSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts empty body object', () => {
    expect(webhookDeliveryPayloadSchema.safeParse({ ...validPayload, body: {} }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// webhookSendPayloadSchema
// ---------------------------------------------------------------------------

describe('webhookSendPayloadSchema', () => {
  const validPayload = {
    id: 'webhook-123',
    url: 'https://example.com/webhook',
    data: { event: 'test' },
    retryCount: 0,
  };

  it('accepts a valid send payload', () => {
    expect(webhookSendPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('accepts payload with optional fields', () => {
    expect(
      webhookSendPayloadSchema.safeParse({
        ...validPayload,
        webhookSecret: 'secret-123',
        correlationId: 'trace-abc',
      }).success,
    ).toBe(true);
  });

  it('rejects missing id', () => {
    const { id: _id, ...rest } = validPayload;
    expect(webhookSendPayloadSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects empty id', () => {
    const result = webhookSendPayloadSchema.safeParse({ ...validPayload, id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL', () => {
    expect(webhookSendPayloadSchema.safeParse({ ...validPayload, url: 'not-a-url' }).success).toBe(false);
  });

  it('rejects negative retryCount', () => {
    const result = webhookSendPayloadSchema.safeParse({ ...validPayload, retryCount: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('non-negative');
    }
  });

  it('rejects non-integer retryCount', () => {
    const result = webhookSendPayloadSchema.safeParse({ ...validPayload, retryCount: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects empty webhookSecret when provided', () => {
    const result = webhookSendPayloadSchema.safeParse({ ...validPayload, webhookSecret: '' });
    expect(result.success).toBe(false);
  });

  it('rejects webhookSecret exceeding 256 chars', () => {
    const result = webhookSendPayloadSchema.safeParse({ ...validPayload, webhookSecret: 'x'.repeat(257) });
    expect(result.success).toBe(false);
  });

  it('rejects non-object data', () => {
    expect(webhookSendPayloadSchema.safeParse({ ...validPayload, data: 'string' }).success).toBe(false);
    expect(webhookSendPayloadSchema.safeParse({ ...validPayload, data: null }).success).toBe(false);
  });

  it('rejects invalid correlationId', () => {
    const result = webhookSendPayloadSchema.safeParse({ ...validPayload, correlationId: 'bad\nid' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookDeliveryResultSchema
// ---------------------------------------------------------------------------

describe('webhookDeliveryResultSchema', () => {
  it('accepts a successful result', () => {
    expect(
      webhookDeliveryResultSchema.safeParse({
        success: true,
        statusCode: 200,
        durationSeconds: 0.5,
      }).success,
    ).toBe(true);
  });

  it('accepts a failure result with circuitOpen', () => {
    expect(
      webhookDeliveryResultSchema.safeParse({
        success: false,
        durationSeconds: 0,
        circuitOpen: true,
      }).success,
    ).toBe(true);
  });

  it('accepts a failure result with enqueueToDoLQ', () => {
    expect(
      webhookDeliveryResultSchema.safeParse({
        success: false,
        statusCode: 500,
        durationSeconds: 1.2,
        enqueueToDoLQ: true,
      }).success,
    ).toBe(true);
  });

  it('rejects missing success', () => {
    expect(
      webhookDeliveryResultSchema.safeParse({
        durationSeconds: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects non-boolean success', () => {
    expect(
      webhookDeliveryResultSchema.safeParse({
        success: 'true',
        durationSeconds: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects negative durationSeconds', () => {
    expect(
      webhookDeliveryResultSchema.safeParse({
        success: true,
        durationSeconds: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects non-integer statusCode', () => {
    expect(
      webhookDeliveryResultSchema.safeParse({
        success: true,
        statusCode: 200.5,
        durationSeconds: 0,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookDLQEntrySchema
// ---------------------------------------------------------------------------

describe('webhookDLQEntrySchema', () => {
  const validEntry = {
    provider: 'stripe',
    url: 'https://example.com/webhook',
    body: { event: 'payment.succeeded' },
    failureReason: '5xx_server_error',
    finalAttemptNumber: 5,
    attemptedAt: 1640995200000,
  };

  it('accepts a valid DLQ entry', () => {
    expect(webhookDLQEntrySchema.safeParse(validEntry).success).toBe(true);
  });

  it('rejects missing provider', () => {
    const { provider: _provider, ...rest } = validEntry;
    expect(webhookDLQEntrySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects empty provider', () => {
    expect(webhookDLQEntrySchema.safeParse({ ...validEntry, provider: '' }).success).toBe(false);
  });

  it('rejects invalid URL', () => {
    expect(webhookDLQEntrySchema.safeParse({ ...validEntry, url: 'not-a-url' }).success).toBe(false);
  });

  it('rejects empty failureReason', () => {
    const result = webhookDLQEntrySchema.safeParse({ ...validEntry, failureReason: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer finalAttemptNumber', () => {
    expect(webhookDLQEntrySchema.safeParse({ ...validEntry, finalAttemptNumber: 1.5 }).success).toBe(false);
  });

  it('rejects finalAttemptNumber less than 1', () => {
    expect(webhookDLQEntrySchema.safeParse({ ...validEntry, finalAttemptNumber: 0 }).success).toBe(false);
  });

  it('rejects negative attemptedAt', () => {
    expect(webhookDLQEntrySchema.safeParse({ ...validEntry, attemptedAt: -1 }).success).toBe(false);
  });
});
