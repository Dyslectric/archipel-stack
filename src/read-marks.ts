import { Store, type User } from "./store.js";
import { WriteBatch } from "./write-batch.js";

// Read positions share the same durable batch as message and inbox commits.
export class ReadMarks {
  constructor(private store: Store, private writes = new WriteBatch(store)) {}
  mark(user: User, input: Record<string, unknown>) {
    return this.writes.run(() => this.store.markRead(user, input));
  }
}
