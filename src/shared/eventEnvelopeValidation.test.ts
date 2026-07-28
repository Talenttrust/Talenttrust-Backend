import {
  isRecord,
  validateEventEnvelopePreamble,
  EnvelopeValidationOptions,
  FieldError,
} from './eventEnvelopeValidation';

/**
 * Build a fully valid envelope. Tests then mutate one field at a time to
 * exercise the per-field branches of `validateEventEnvelopePreamble`.
 */
function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: 1_700_000_000_000, // numeric epoch (ms) — covers `toFiniteNumber`
    payload: { foo: 'bar' },
    ...overrides,
  };
}

/** Shared options used by most tests in this file. */
const NUMERIC_NO_ABORT: EnvelopeValidationOptions = {
  rootErrorMessage: 'Event must be a JSON object.',
  messageSuffix: '.',
  timestampRule: 'numeric',
  abortEarly: false,
};

const ISO_NO_ABORT: EnvelopeValidationOptions = {
  rootErrorMessage: 'Payload must be a JSON object',
  messageSuffix: '',
  timestampRule: 'iso',
  abortEarly: false,
};

const ISO_ABORT: EnvelopeValidationOptions = {
  rootErrorMessage: 'Payload must be a JSON object',
  messageSuffix: '',
  timestampRule: 'iso',
  abortEarly: true,
};

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for null and undefined', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isRecord('x')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });

  it('returns false for arrays (even empty arrays)', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
  });
});

describe('validateEventEnvelopePreamble — happy path', () => {
  it('returns no errors for a fully valid envelope (numeric timestamp)', () => {
    const errors = validateEventEnvelopePreamble(makeEnvelope(), NUMERIC_NO_ABORT);
    expect(errors).toEqual([]);
  });

  it('returns no errors for a fully valid envelope (ISO timestamp)', () => {
    const envelope = { ...makeEnvelope(), timestamp: '2024-01-01T00:00:00.000Z' };
    const errors = validateEventEnvelopePreamble(envelope, ISO_NO_ABORT);
    expect(errors).toEqual([]);
  });

  it('accepts numeric-string timestamps under the numeric rule', () => {
    const envelope = { ...makeEnvelope(), timestamp: '1700000000000' };
    expect(validateEventEnvelopePreamble(envelope, NUMERIC_NO_ABORT)).toEqual([]);
  });

  it('rejects a numeric epoch when the rule is ISO (no Date.parse of a number)', () => {
    const envelope = { ...makeEnvelope(), timestamp: 1_700_000_000_000 };
    const errors = validateEventEnvelopePreamble(envelope, ISO_NO_ABORT);
    expect(errors).toEqual([
      { field: 'timestamp', message: 'timestamp must be a valid ISO string' },
    ]);
  });

  it('accepts an ISO string when the rule is ISO', () => {
    const envelope = { ...makeEnvelope(), timestamp: '2024-13-01T00:00:00.000Z' };
    // First assert parse failure, then accept valid ISO.
    expect(validateEventEnvelopePreamble({ ...envelope }, ISO_NO_ABORT)).toHaveLength(1);
    const ok = { ...envelope, timestamp: '2024-01-01T00:00:00.000Z' };
    expect(validateEventEnvelopePreamble(ok, ISO_NO_ABORT)).toEqual([]);
  });
});

describe('validateEventEnvelopePreamble — root shape', () => {
  it('emits the root error when the input is not an object', () => {
    const cases: unknown[] = [null, undefined, 'x', 1, true, []];
    for (const value of cases) {
      const errors = validateEventEnvelopePreamble(value, NUMERIC_NO_ABORT);
      expect(errors).toEqual([
        { field: 'event', message: 'Event must be a JSON object.' },
      ]);
    }
  });

  it('uses the configured root error message verbatim (no suffix variant)', () => {
    const errors = validateEventEnvelopePreamble('not-an-object', ISO_NO_ABORT);
    expect(errors).toEqual([
      { field: 'event', message: 'Payload must be a JSON object' },
    ]);
  });

  it('short-circuits on root shape failure even when abortEarly=true', () => {
    const errors = validateEventEnvelopePreamble(null, ISO_ABORT);
    expect(errors).toEqual([
      { field: 'event', message: 'Payload must be a JSON object' },
    ]);
  });
});

describe('validateEventEnvelopePreamble — contractId branch', () => {
  it.each([
    ['missing', undefined],
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['number', 123],
    ['null', null],
    ['array', ['x']],
  ])('rejects contractId when value is %s', (_label, value) => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ contractId: value }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'contractId', message: 'contractId is required.' },
    ]);
  });

  it('respects messageSuffix (no suffix when caller passes "")', () => {
    // The default makeEnvelope() timestamp is numeric, which fails the ISO rule.
    // Override to a valid ISO string so this test isolates the contractId rejection.
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ contractId: '', timestamp: '2024-01-01T00:00:00.000Z' }),
      ISO_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'contractId', message: 'contractId is required' },
    ]);
  });

  it('short-circuits on contractId failure with abortEarly=true', () => {
    const errors = validateEventEnvelopePreamble(
      { ...makeEnvelope(), contractId: '', eventId: '', sequence: -1 },
      ISO_ABORT,
    );
    // Only the first failing field is reported.
    expect(errors).toEqual([
      { field: 'contractId', message: 'contractId is required' },
    ]);
  });
});

describe('validateEventEnvelopePreamble — eventId branch', () => {
  it('rejects missing/empty/non-string eventId', () => {
    for (const value of [undefined, '', '   ', 0, false, null] as unknown[]) {
      const errors = validateEventEnvelopePreamble(
        makeEnvelope({ eventId: value }),
        NUMERIC_NO_ABORT,
      );
      expect(errors).toContainEqual({
        field: 'eventId',
        message: 'eventId is required.',
      });
    }
  });

  it('produces both contractId and eventId errors when abortEarly=false', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ contractId: '', eventId: '' }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        { field: 'contractId', message: 'contractId is required.' },
        { field: 'eventId', message: 'eventId is required.' },
      ]),
    );
  });
});

describe('validateEventEnvelopePreamble — sequence branch', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['float', 1.5],
    ['negative integer', -1],
    ['NaN', NaN],
    ['string', '1'],
  ])('rejects sequence when value is %s', (_label, value) => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ sequence: value }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'sequence', message: 'sequence must be a non-negative integer.' },
    ]);
  });

  it('accepts sequence=0', () => {
    expect(
      validateEventEnvelopePreamble(makeEnvelope({ sequence: 0 }), NUMERIC_NO_ABORT),
    ).toEqual([]);
  });
});

describe('validateEventEnvelopePreamble — timestamp branches', () => {
  it('rejects a non-string when ISO rule is active', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ timestamp: 1_700_000_000_000 }),
      ISO_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'timestamp', message: 'timestamp must be a valid ISO string' },
    ]);
  });

  it('rejects a string Date.parse cannot parse when ISO rule is active', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ timestamp: 'not-a-date' }),
      ISO_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'timestamp', message: 'timestamp must be a valid ISO string' },
    ]);
  });

  it('rejects a non-finite number when numeric rule is active', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ timestamp: NaN }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'timestamp', message: 'timestamp must be a valid epoch number or numeric string.' },
    ]);
  });

  it('rejects a non-numeric string when numeric rule is active', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ timestamp: 'not-a-number' }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'timestamp', message: 'timestamp must be a valid epoch number or numeric string.' },
    ]);
  });

  it('rejects an empty string when numeric rule is active', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ timestamp: '' }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'timestamp', message: 'timestamp must be a valid epoch number or numeric string.' },
    ]);
  });

  it('rejects a whitespace-only string when numeric rule is active', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ timestamp: '   ' }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'timestamp', message: 'timestamp must be a valid epoch number or numeric string.' },
    ]);
  });

  it('accepts an infinite number under numeric rule', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ timestamp: Number.POSITIVE_INFINITY }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toContainEqual({
      field: 'timestamp',
      message: 'timestamp must be a valid epoch number or numeric string.',
    });
  });
});

describe('validateEventEnvelopePreamble — payload branch', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', 'x'],
    ['number', 1],
    ['array', []],
  ])('rejects payload when value is %s', (_label, value) => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ payload: value }),
      NUMERIC_NO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'payload', message: 'payload must be an object.' },
    ]);
  });

  it('accepts an empty object as payload', () => {
    expect(
      validateEventEnvelopePreamble(makeEnvelope({ payload: {} }), NUMERIC_NO_ABORT),
    ).toEqual([]);
  });
});

describe('validateEventEnvelopePreamble — abortEarly behaviour', () => {
  it('returns only the first failing field when abortEarly=true', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ contractId: '', eventId: '', sequence: -1 }),
      ISO_ABORT,
    );
    expect(errors).toEqual([
      { field: 'contractId', message: 'contractId is required' },
    ]);
  });

  it('returns every failing field when abortEarly=false', () => {
    const errors = validateEventEnvelopePreamble(
      makeEnvelope({ contractId: '', eventId: '', sequence: -1, payload: 'bad' }),
      ISO_NO_ABORT,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        { field: 'contractId', message: 'contractId is required' },
        { field: 'eventId', message: 'eventId is required' },
        { field: 'sequence', message: 'sequence must be a non-negative integer' },
        { field: 'payload', message: 'payload must be an object' },
      ]),
    );
  });
});

describe('validateEventEnvelopePreamble — message shaping', () => {
  it('appends messageSuffix to every per-field message', () => {
    const opts: EnvelopeValidationOptions = {
      rootErrorMessage: 'X',
      messageSuffix: '!!!',
      timestampRule: 'numeric',
      abortEarly: false,
    };
    const errors: FieldError[] = validateEventEnvelopePreamble(
      makeEnvelope({ contractId: '', eventId: '', sequence: -1 }),
      opts,
    );
    expect(errors.map((e) => e.message)).toEqual([
      'contractId is required!!!',
      'eventId is required!!!',
      'sequence must be a non-negative integer!!!',
    ]);
  });

  it('uses rootErrorMessage verbatim on root failures (not suffixed)', () => {
    const opts: EnvelopeValidationOptions = {
      rootErrorMessage: 'Root says no',
      messageSuffix: '.',
      timestampRule: 'numeric',
      abortEarly: false,
    };
    expect(validateEventEnvelopePreamble(null, opts)).toEqual([
      { field: 'event', message: 'Root says no' },
    ]);
  });
});
