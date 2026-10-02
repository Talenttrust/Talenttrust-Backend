/**
 * @file schemaVersion.test.ts
 * @description Unit tests for the contract schema-version classifier
 * (`src/events/schemaVersion.ts`): known, unknown, malformed, and absent.
 */

import { classifySchemaVersion, KNOWN_SCHEMA_VERSIONS, LEGACY_SCHEMA_VERSION } from './schemaVersion';

describe('classifySchemaVersion', () => {
  it('treats an absent version as legacy (version 1)', () => {
    expect(classifySchemaVersion(undefined)).toEqual({ status: 'absent' });
    expect(LEGACY_SCHEMA_VERSION).toBe(1);
  });

  it('classifies a known version as known', () => {
    expect(classifySchemaVersion(1)).toEqual({ status: 'known', version: 1 });
  });

  it('classifies a newer version as unknown', () => {
    expect(classifySchemaVersion(2)).toEqual({ status: 'unknown', version: 2 });
    expect(classifySchemaVersion(99)).toEqual({ status: 'unknown', version: 99 });
  });

  it('rejects malformed versions (fail-closed)', () => {
    expect(classifySchemaVersion(0).status).toBe('malformed');
    expect(classifySchemaVersion(-1).status).toBe('malformed');
    expect(classifySchemaVersion(1.5).status).toBe('malformed');
    expect(classifySchemaVersion('1' as unknown as number).status).toBe('malformed');
  });

  it('respects an overridden known set (simulated contract upgrade)', () => {
    expect(classifySchemaVersion(2, [1, 2])).toEqual({ status: 'known', version: 2 });
    expect(classifySchemaVersion(3, [1, 2])).toEqual({ status: 'unknown', version: 3 });
  });

  it('defaults to the platform known set', () => {
    expect(KNOWN_SCHEMA_VERSIONS).toContain(1);
    expect(classifySchemaVersion(1, KNOWN_SCHEMA_VERSIONS).status).toBe('known');
  });
});
