import { Store, Problem } from "./store.js";

type Pending = { run: () => unknown; done: (value: unknown) => void; fail: (error: unknown) => void };

// Synchronous operations share a durable commit, with a savepoint per request.
// No response resolves before commit; policy failures affect only that operation,
// and a storage error rolls the complete batch back without acknowledging success.
export class WriteBatch {
  private pending: Pending[] = [];
  private timer: NodeJS.Timeout | undefined;
  constructor(private store: Store) {}
  run<T>(operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): Promise<T> {
    return new Promise<T>((done, fail) => {
      this.pending.push({ run: operation, done: value => done(value as T), fail });
      this.timer ??= setTimeout(() => this.flush(), 50);
      if (this.pending.length >= 128) this.flush();
    });
  }
  private flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const batch = this.pending; this.pending = [];
    const results: { value?: unknown; error?: unknown }[] = [];
    try {
      this.store.transaction(() => {
        for (const item of batch) {
          try { results.push({ value: this.store.db.savepoint(() => {
            const value = item.run();
            if (value && typeof (value as { then?: unknown }).then === "function")
              throw new Error("Write batch operations must be synchronous.");
            return value;
          }, { atomic: true }) }); }
          catch (error) {
            if (!(error instanceof Problem)) throw error;
            results.push({ error });
          }
        }
      });
      batch.forEach((item, i) => results[i].error ? item.fail(results[i].error) : item.done(results[i].value));
    } catch (error) { for (const item of batch) item.fail(error); }
  }
}
