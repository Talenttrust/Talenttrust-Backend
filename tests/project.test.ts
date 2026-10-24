import { parseFieldSpec, project, ALLOWED_FIELDS } from '../src/utils/project';
import { EscrowStore, EscrowContract, HttpError } from '../src/store';

describe('project()', () => {
  // Build a real contract via the store so the shape is realistic.
  const store = new EscrowStore();
  const created = store.create({
    title: 'Landing page redesign',
    client: 'GA',
    freelancer: 'GB',
    milestones: [
      { title: 'Wireframes', amount: 250 },
      { title: 'Visual design', amount: 500 },
    ],
  });
  store.deposit(created.id, 750);
  store.release(created.id, 0);
  const full: EscrowContract = store.get(created.id);

  it('returns the object untouched when spec is null', () => {
    const out = project(full, null);
    expect(out).toBe(full); // same reference — no copy when not projecting
  });

  it('always includes id even when not requested', () => {
    const spec = parseFieldSpec('title,status');
    const out = project(full, spec);
    expect(Object.keys(out).sort()).toEqual(['id', 'status', 'title']);
    expect(out.id).toBe(full.id);
  });

  it('does not mutate the stored contract', () => {
    const spec = parseFieldSpec('title,status');
    const out = project(full, spec);
    // Mutating the projection must not affect the source.
    (out as unknown as Record<string, unknown>).title = 'CHANGED';
    expect(full.title).toBe('Landing page redesign');

    const after = store.get(created.id);
    expect(after.title).toBe('Landing page redesign');
    expect(after.milestones.length).toBe(2);
    expect(after.milestones[0].released).toBe(true);
    expect(after.status).toBe('Funded');
  });

  it('returns only id,title,status for ?fields=title,status', () => {
    const out = project(full, parseFieldSpec('title,status'));
    expect(Object.keys(out).sort()).toEqual(['id', 'status', 'title']);
  });

  it('supports milestones.amount nested selection', () => {
    const out = project(full, parseFieldSpec('milestones.amount'));
    expect(out.milestones).toBeDefined();
    expect(Array.isArray(out.milestones)).toBe(true);
    expect(out.milestones!.length).toBe(2);
    out.milestones!.forEach((m) => {
      expect(Object.keys(m).sort()).toEqual(['amount']);
    });
    expect(out.milestones![0].amount).toBe(250);
    expect(out.milestones![1].amount).toBe(500);
  });

  it('supports milestones with multiple sub-fields', () => {
    const out = project(full, parseFieldSpec('milestones.title,milestones.released'));
    out.milestones!.forEach((m) => {
      expect(Object.keys(m).sort()).toEqual(['released', 'title']);
    });
  });

  it('milestones without sub-fields returns full milestone objects', () => {
    const out = project(full, parseFieldSpec('milestones'));
    out.milestones!.forEach((m) => {
      expect(m).toHaveProperty('index');
      expect(m).toHaveProperty('title');
      expect(m).toHaveProperty('amount');
      expect(m).toHaveProperty('released');
    });
  });

  it('deep-copies milestone array elements (no shared references)', () => {
    const out = project(full, parseFieldSpec('milestones'));
    out.milestones![0].title = 'mutated';
    expect(full.milestones[0].title).toBe('Wireframes');
  });

  it('deep-copies dispute object', () => {
    store.openDispute(created.id, 'GA', 'reason');
    const disputed = store.get(created.id);
    const out = project(disputed, parseFieldSpec('dispute'));
    (out.dispute as unknown as Record<string, unknown>).reason = 'mutated';
    expect(disputed.dispute!.reason).toBe('reason');
  });

  it('includes id when explicitly requested', () => {
    const out = project(full, parseFieldSpec('id,title'));
    expect(Object.keys(out).sort()).toEqual(['id', 'title']);
  });

  it('empty string spec returns all fields (no projection)', () => {
    // parseFieldSpec('') yields empty top set → project keeps all keys
    const out = project(full, parseFieldSpec(''));
    expect(out).toEqual(full);
    expect(out).not.toBe(full); // must be a copy when projecting
  });

  it('whitelist covers all EscrowContract keys except id', () => {
    const expectedKeys = Object.keys(full).filter((k) => k !== 'id');
    expect(ALLOWED_FIELDS.length).toBe(expectedKeys.length);
    expectedKeys.forEach((k) => expect(ALLOWED_FIELDS).toContain(k));
  });
});

describe('parseFieldSpec() validation', () => {
  it('throws 400 invalid_fields for unknown top-level field', () => {
    try {
      parseFieldSpec('title,bogus');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(400);
      expect((e as HttpError).code).toBe('invalid_fields');
      expect((e as HttpError).message).toContain('bogus');
    }
  });

  it('throws 400 for unknown nested parent', () => {
    expect(() => parseFieldSpec('title.sub')).toThrow(HttpError);
  });

  it('throws 400 for unknown milestone sub-field', () => {
    expect(() => parseFieldSpec('milestones.bogus')).toThrow(HttpError);
  });

  it('throws 400 for empty nested field after dot', () => {
    expect(() => parseFieldSpec('milestones.')).toThrow(HttpError);
  });

  it('error message lists valid fields', () => {
    try {
      parseFieldSpec('bogus');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as HttpError).message).toContain('title');
      expect((e as HttpError).message).toContain('status');
      expect((e as HttpError).message).toContain('milestones');
    }
  });

  it('ignores whitespace around tokens', () => {
    const spec = parseFieldSpec('  title ,  status  ');
    expect(spec.top.has('title')).toBe(true);
    expect(spec.top.has('status')).toBe(true);
  });

  it('empty string produces empty spec (all fields kept)', () => {
    const spec = parseFieldSpec('');
    expect(spec.top.size).toBe(0);
    expect(spec.nested.size).toBe(0);
  });
});
