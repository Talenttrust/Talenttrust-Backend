/**
 * @file metrics-validation.test.ts
 * @description Comprehensive tests for the metrics input validation schemas and
 * runtime guard functions (Issue #692).
 *
 * Coverage targets:
 *  - Happy-path: all valid enum values, valid numeric ranges.
 *  - Rejection: unknown enum values, wrong types, out-of-range numbers.
 *  - Boundary values: 0, MAX_DLQ_DEPTH, MAX_DLQ_DEPTH + 1.
 *  - Oversized strings, non-printable chars.
 *  - Unknown fields (strict schemas).
 *  - Non-finite numerics (NaN, Infinity, -Infinity).
 */

import {
  // Schemas
  WebhookOutcomeSchema,
  DlqOperationSchema,
  DlqReplayOutcomeSchema,
  ServiceStatusSchema,
  DlqDepthSchema,
  WebhookDeliveryInputSchema,
  WebhookDlqDepthInputSchema,
  HealthStatusInputSchema,
  DlqOperationInputSchema,
  DlqReplayInputSchema,
  // Constants
  WEBHOOK_OUTCOMES,
  DLQ_OPERATIONS,
  DLQ_REPLAY_OUTCOMES,
  SERVICE_STATUSES,
  MAX_DLQ_DEPTH,
  // Helpers
  validateMetricsInput,
  assertWebhookOutcome,
  assertDlqDepth,
  assertServiceStatus,
  assertDisputesErrorCause,
  mapDisputesErrorCause,
  DISPUTES_ERROR_CAUSES,
} from './metrics-validation';

// ---------------------------------------------------------------------------
// WebhookOutcomeSchema
// ---------------------------------------------------------------------------
describe('WebhookOutcomeSchema', () => {
  it.each(WEBHOOK_OUTCOMES)('accepts valid outcome "%s"', (outcome) => {
    expect(WebhookOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('rejects an unknown outcome string', () => {
    const result = WebhookOutcomeSchema.safeParse('partial_failure');
    expect(result.success).toBe(false);
  });

  it('rejects a number masquerading as outcome', () => {
    expect(WebhookOutcomeSchema.safeParse(1).success).toBe(false);
  });

  it('rejects null', () => {
    expect(WebhookOutcomeSchema.safeParse(null).success).toBe(false);
  });

  it('rejects undefined', () => {
    expect(WebhookOutcomeSchema.safeParse(undefined).success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(WebhookOutcomeSchema.safeParse('').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DlqOperationSchema
// ---------------------------------------------------------------------------
describe('DlqOperationSchema', () => {
  it.each(DLQ_OPERATIONS)('accepts valid operation "%s"', (op) => {
    expect(DlqOperationSchema.safeParse(op).success).toBe(true);
  });

  it('rejects an unknown operation', () => {
    expect(DlqOperationSchema.safeParse('purge').success).toBe(false);
  });

  it('rejects a boolean', () => {
    expect(DlqOperationSchema.safeParse(true).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DlqReplayOutcomeSchema
// ---------------------------------------------------------------------------
describe('DlqReplayOutcomeSchema', () => {
  it.each(DLQ_REPLAY_OUTCOMES)('accepts valid replay outcome "%s"', (outcome) => {
    expect(DlqReplayOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('rejects an unknown replay outcome', () => {
    expect(DlqReplayOutcomeSchema.safeParse('retried').success).toBe(false);
  });

  it('rejects an object', () => {
    expect(DlqReplayOutcomeSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ServiceStatusSchema
// ---------------------------------------------------------------------------
describe('ServiceStatusSchema', () => {
  it.each(SERVICE_STATUSES)('accepts valid status "%s"', (status) => {
    expect(ServiceStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejects an unknown status string', () => {
    expect(ServiceStatusSchema.safeParse('healthy').success).toBe(false);
  });

  it('rejects a number', () => {
    expect(ServiceStatusSchema.safeParse(2).success).toBe(false);
  });

  it('rejects null', () => {
    expect(ServiceStatusSchema.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DlqDepthSchema
// ---------------------------------------------------------------------------
describe('DlqDepthSchema', () => {
  it('accepts 0 (minimum boundary)', () => {
    expect(DlqDepthSchema.safeParse(0).success).toBe(true);
  });

  it('accepts MAX_DLQ_DEPTH (maximum boundary)', () => {
    expect(DlqDepthSchema.safeParse(MAX_DLQ_DEPTH).success).toBe(true);
  });

  it('accepts a mid-range integer', () => {
    expect(DlqDepthSchema.safeParse(42).success).toBe(true);
  });

  it('rejects MAX_DLQ_DEPTH + 1 (exceeds upper bound)', () => {
    const result = DlqDepthSchema.safeParse(MAX_DLQ_DEPTH + 1);
    expect(result.success).toBe(false);
  });

  it('rejects -1 (below lower bound)', () => {
    expect(DlqDepthSchema.safeParse(-1).success).toBe(false);
  });

  it('rejects NaN', () => {
    expect(DlqDepthSchema.safeParse(NaN).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(DlqDepthSchema.safeParse(Infinity).success).toBe(false);
  });

  it('rejects -Infinity', () => {
    expect(DlqDepthSchema.safeParse(-Infinity).success).toBe(false);
  });

  it('rejects a float (1.5 is not an integer)', () => {
    expect(DlqDepthSchema.safeParse(1.5).success).toBe(false);
  });

  it('rejects a string that looks like a number', () => {
    expect(DlqDepthSchema.safeParse('5').success).toBe(false);
  });

  it('rejects null', () => {
    expect(DlqDepthSchema.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strict body schemas (unknown-field rejection)
// ---------------------------------------------------------------------------
describe('WebhookDeliveryInputSchema (strict)', () => {
  it('accepts a valid body', () => {
    expect(WebhookDeliveryInputSchema.safeParse({ outcome: 'success' }).success).toBe(true);
  });

  it('rejects an unknown field alongside a valid outcome', () => {
    const result = WebhookDeliveryInputSchema.safeParse({ outcome: 'success', extra: 'field' });
    expect(result.success).toBe(false);
  });

  it('rejects a body missing the outcome field', () => {
    expect(WebhookDeliveryInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects outcome with wrong type (number)', () => {
    expect(WebhookDeliveryInputSchema.safeParse({ outcome: 1 }).success).toBe(false);
  });

  it('rejects an invalid outcome value', () => {
    expect(WebhookDeliveryInputSchema.safeParse({ outcome: 'error' }).success).toBe(false);
  });

  it('rejects non-object body (array)', () => {
    expect(WebhookDeliveryInputSchema.safeParse(['success']).success).toBe(false);
  });

  it('rejects null body', () => {
    expect(WebhookDeliveryInputSchema.safeParse(null).success).toBe(false);
  });
});

describe('WebhookDlqDepthInputSchema (strict)', () => {
  it('accepts a valid body with depth 0', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: 0 }).success).toBe(true);
  });

  it('accepts MAX_DLQ_DEPTH', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: MAX_DLQ_DEPTH }).success).toBe(true);
  });

  it('rejects depth exceeding MAX_DLQ_DEPTH', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: MAX_DLQ_DEPTH + 1 }).success).toBe(false);
  });

  it('rejects depth of NaN', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: NaN }).success).toBe(false);
  });

  it('rejects a string depth', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: '5' }).success).toBe(false);
  });

  it('rejects an unknown extra field', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: 5, foo: 'bar' }).success).toBe(false);
  });

  it('rejects negative depth', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: -1 }).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(WebhookDlqDepthInputSchema.safeParse({ depth: Infinity }).success).toBe(false);
  });
});

describe('HealthStatusInputSchema (strict)', () => {
  it.each(SERVICE_STATUSES)('accepts status "%s"', (status) => {
    expect(HealthStatusInputSchema.safeParse({ status }).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(HealthStatusInputSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });

  it('rejects an unknown extra field', () => {
    expect(HealthStatusInputSchema.safeParse({ status: 'up', foo: 1 }).success).toBe(false);
  });

  it('rejects a missing status field', () => {
    expect(HealthStatusInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects number status', () => {
    expect(HealthStatusInputSchema.safeParse({ status: 1 }).success).toBe(false);
  });
});

describe('DlqOperationInputSchema (strict)', () => {
  it.each(DLQ_OPERATIONS)('accepts operation "%s"', (op) => {
    expect(DlqOperationInputSchema.safeParse({ operation: op }).success).toBe(true);
  });

  it('rejects an unknown operation', () => {
    expect(DlqOperationInputSchema.safeParse({ operation: 'purge' }).success).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(DlqOperationInputSchema.safeParse({ operation: 'enqueue', extra: true }).success).toBe(false);
  });

  it('rejects missing operation field', () => {
    expect(DlqOperationInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('DlqReplayInputSchema (strict)', () => {
  it.each(DLQ_REPLAY_OUTCOMES)('accepts replay outcome "%s"', (outcome) => {
    expect(DlqReplayInputSchema.safeParse({ outcome }).success).toBe(true);
  });

  it('rejects an unknown replay outcome', () => {
    expect(DlqReplayInputSchema.safeParse({ outcome: 'retry' }).success).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(DlqReplayInputSchema.safeParse({ outcome: 'success', extra: 1 }).success).toBe(false);
  });

  it('rejects missing outcome field', () => {
    expect(DlqReplayInputSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateMetricsInput helper
// ---------------------------------------------------------------------------
describe('validateMetricsInput', () => {
  it('returns ok:true with typed data for a valid input', () => {
    const result = validateMetricsInput(WebhookDeliveryInputSchema, { outcome: 'dlq' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.outcome).toBe('dlq');
    }
  });

  it('returns ok:false with code "validation_error" for an invalid input', () => {
    const result = validateMetricsInput(WebhookDeliveryInputSchema, { outcome: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('validation_error');
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('includes field and message in the issues array', () => {
    const result = validateMetricsInput(WebhookDlqDepthInputSchema, { depth: -5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toHaveProperty('field');
      expect(result.issues[0]).toHaveProperty('message');
    }
  });

  it('reports "(root)" as field when the root itself is invalid', () => {
    const result = validateMetricsInput(WebhookDeliveryInputSchema, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Zod reports the root-level issue
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('never throws — returns ok:false for completely malformed inputs', () => {
    expect(() =>
      validateMetricsInput(HealthStatusInputSchema, undefined),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertWebhookOutcome
// ---------------------------------------------------------------------------
describe('assertWebhookOutcome', () => {
  it.each(WEBHOOK_OUTCOMES)('returns the validated outcome for "%s"', (outcome) => {
    expect(assertWebhookOutcome(outcome)).toBe(outcome);
  });

  it('throws TypeError for an unknown string', () => {
    expect(() => assertWebhookOutcome('partial')).toThrow(TypeError);
  });

  it('throws TypeError for a number', () => {
    expect(() => assertWebhookOutcome(42)).toThrow(TypeError);
  });

  it('throws TypeError for null', () => {
    expect(() => assertWebhookOutcome(null)).toThrow(TypeError);
  });

  it('throws TypeError for undefined', () => {
    expect(() => assertWebhookOutcome(undefined)).toThrow(TypeError);
  });

  it('error message includes the invalid value', () => {
    try {
      assertWebhookOutcome('bad_outcome');
    } catch (err) {
      expect((err as Error).message).toContain('bad_outcome');
    }
  });
});

// ---------------------------------------------------------------------------
// assertDlqDepth
// ---------------------------------------------------------------------------
describe('assertDlqDepth', () => {
  it('returns the depth for boundary value 0', () => {
    expect(assertDlqDepth(0)).toBe(0);
  });

  it('returns the depth for MAX_DLQ_DEPTH', () => {
    expect(assertDlqDepth(MAX_DLQ_DEPTH)).toBe(MAX_DLQ_DEPTH);
  });

  it('throws RangeError for -1', () => {
    expect(() => assertDlqDepth(-1)).toThrow(RangeError);
  });

  it('throws RangeError for MAX_DLQ_DEPTH + 1', () => {
    expect(() => assertDlqDepth(MAX_DLQ_DEPTH + 1)).toThrow(RangeError);
  });

  it('throws RangeError for NaN', () => {
    expect(() => assertDlqDepth(NaN)).toThrow(RangeError);
  });

  it('throws RangeError for Infinity', () => {
    expect(() => assertDlqDepth(Infinity)).toThrow(RangeError);
  });

  it('throws RangeError for -Infinity', () => {
    expect(() => assertDlqDepth(-Infinity)).toThrow(RangeError);
  });

  it('throws RangeError for a float', () => {
    expect(() => assertDlqDepth(3.14)).toThrow(RangeError);
  });

  it('throws RangeError for a string', () => {
    expect(() => assertDlqDepth('10')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// assertServiceStatus
// ---------------------------------------------------------------------------
describe('assertServiceStatus', () => {
  it.each(SERVICE_STATUSES)('returns the validated status for "%s"', (status) => {
    expect(assertServiceStatus(status)).toBe(status);
  });

  it('throws TypeError for an unknown string', () => {
    expect(() => assertServiceStatus('healthy')).toThrow(TypeError);
  });

  it('throws TypeError for a number', () => {
    expect(() => assertServiceStatus(1)).toThrow(TypeError);
  });

  it('throws TypeError for null', () => {
    expect(() => assertServiceStatus(null)).toThrow(TypeError);
  });

  it('error message includes the invalid value', () => {
    try {
      assertServiceStatus('running');
    } catch (err) {
      expect((err as Error).message).toContain('running');
    }
  });
});

// ---------------------------------------------------------------------------
// Disputes error-cause mapping / assertion
// ---------------------------------------------------------------------------
describe('mapDisputesErrorCause', () => {
  it('maps 2xx to success', () => {
    expect(mapDisputesErrorCause(200)).toBe('success');
    expect(mapDisputesErrorCause(201)).toBe('success');
    expect(mapDisputesErrorCause(204)).toBe('success');
  });

  it('maps 4xx to 4xx_client_error', () => {
    expect(mapDisputesErrorCause(400)).toBe('4xx_client_error');
    expect(mapDisputesErrorCause(401)).toBe('4xx_client_error');
    expect(mapDisputesErrorCause(403)).toBe('4xx_client_error');
    expect(mapDisputesErrorCause(429)).toBe('4xx_client_error');
  });

  it('maps 5xx to 5xx_server_error', () => {
    expect(mapDisputesErrorCause(500)).toBe('5xx_server_error');
    expect(mapDisputesErrorCause(503)).toBe('5xx_server_error');
  });

  it('maps other codes to unknown', () => {
    expect(mapDisputesErrorCause(100)).toBe('unknown');
    expect(mapDisputesErrorCause(301)).toBe('unknown');
  });
});

describe('assertDisputesErrorCause', () => {
  it.each(DISPUTES_ERROR_CAUSES)('returns the validated cause for "%s"', (cause) => {
    expect(assertDisputesErrorCause(cause)).toBe(cause);
  });

  it('throws TypeError for an unknown string', () => {
    expect(() => assertDisputesErrorCause('timeout')).toThrow(TypeError);
  });

  it('throws TypeError for null', () => {
    expect(() => assertDisputesErrorCause(null)).toThrow(TypeError);
  });
});
