import { InMemoryCursorRepository } from './cursor.repository';

describe('InMemoryCursorRepository', () => {
  it('returns null for non-existent cursor', async () => {
    const repo = new InMemoryCursorRepository();
    const cursor = await repo.getCursor('unknown-source');
    expect(cursor).toBeNull();
  });

  it('stores and retrieves cursor', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);

    const cursor = await repo.getCursor('source-1');
    expect(cursor).not.toBeNull();
    expect(cursor!.sourceId).toBe('source-1');
    expect(cursor!.lastSequence).toBe(100);
    expect(cursor!.updatedAt).toBeDefined();
  });

  it('updates cursor with higher sequence', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);
    await repo.updateCursor('source-1', 150);

    const cursor = await repo.getCursor('source-1');
    expect(cursor!.lastSequence).toBe(150);
  });

  it('can update cursor with lower sequence (non-enforcing)', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 150);
    const result = await repo.updateCursor('source-1', 100);

    expect(result.success).toBe(true);
    expect(result.cursor.lastSequence).toBe(100);
  });

  it('stores and retrieves metadata', async () => {
    const repo = new InMemoryCursorRepository();
    const meta = { blockHash: 'abc123', checkpoint: 'phase-1' };
    await repo.updateCursor('source-1', 100, meta);

    const cursor = await repo.getCursor('source-1');
    expect(cursor!.metadata).toEqual(meta);
  });

  it('lists all cursors', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);
    await repo.updateCursor('source-2', 200);
    await repo.updateCursor('source-3', 300);

    const cursors = await repo.listCursors();
    expect(cursors).toHaveLength(3);
    expect(cursors.map((c) => c.sourceId)).toEqual(['source-1', 'source-2', 'source-3']);
  });

  it('deletes cursor', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);

    const deleted = await repo.deleteCursor('source-1');
    expect(deleted).toBe(true);

    const cursor = await repo.getCursor('source-1');
    expect(cursor).toBeNull();
  });

  it('returns false when deleting non-existent cursor', async () => {
    const repo = new InMemoryCursorRepository();
    const deleted = await repo.deleteCursor('unknown-source');
    expect(deleted).toBe(false);
  });

  it('update returns success with cursor data', async () => {
    const repo = new InMemoryCursorRepository();
    const result = await repo.updateCursor('source-1', 99, { key: 'value' });

    expect(result.success).toBe(true);
    expect(result.cursor.sourceId).toBe('source-1');
    expect(result.cursor.lastSequence).toBe(99);
    expect(result.cursor.metadata).toEqual({ key: 'value' });
  });

  it('maintains isolation between separate cursors', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-a', 100);
    await repo.updateCursor('source-b', 200);
    await repo.updateCursor('source-a', 150);

    const cursorA = await repo.getCursor('source-a');
    const cursorB = await repo.getCursor('source-b');

    expect(cursorA!.lastSequence).toBe(150);
    expect(cursorB!.lastSequence).toBe(200);
  });
});
