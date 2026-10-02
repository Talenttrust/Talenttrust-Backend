import { AUDIT_ACTIONS, AUDIT_SEVERITIES } from './types';

describe('audit type registries', () => {
  it('exposes a unique, immutable action registry', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS).toContain('CONTRACT_DELETED');
    expect(AUDIT_ACTIONS).toContain('MILESTONES_CREATED');
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
  });

  it('keeps severity values unique and ordered for stable validation', () => {
    expect(AUDIT_SEVERITIES).toEqual(['INFO', 'WARNING', 'CRITICAL']);
    expect(new Set(AUDIT_SEVERITIES).size).toBe(AUDIT_SEVERITIES.length);
  });
});
