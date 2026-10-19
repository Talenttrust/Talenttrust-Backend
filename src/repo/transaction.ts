import { AsyncLocalStorage } from 'node:async_hooks';

/** Serialize access across awaits; unrelated requests must never join a transaction. */
export abstract class TransactionalRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private context = new AsyncLocalStorage<{ active: boolean; failed: boolean; error?: unknown }>();
  private closed = false;

  protected abstract begin(): void | Promise<void>;
  protected abstract commit(): void;
  protected abstract rollback(): void;
  protected abstract dispose(): void;

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current?.active) {
      return Promise.resolve().then(fn).catch((error) => {
        current.failed = true;
        current.error = error;
        throw error;
      });
    }
    return this.exclusive(async () => {
      if (this.closed) throw new Error('Repository is closed');
      await this.begin();
      const state = { active: true, failed: false, error: undefined as unknown };
      return this.context.run(state, async () => {
        try {
          const result = await fn();
          if (state.failed) throw state.error;
          this.commit();
          return result;
        } catch (error) {
          this.rollback();
          throw error;
        } finally {
          state.active = false;
        }
      });
    });
  }

  protected access<T>(fn: () => T): Promise<T> {
    return this.transaction(async () => fn());
  }

  close(): Promise<void> {
    if (this.context.getStore()?.active) return Promise.reject(new Error('Cannot close inside a transaction'));
    return this.exclusive(async () => {
      if (!this.closed) { this.dispose(); this.closed = true; }
    });
  }
}
