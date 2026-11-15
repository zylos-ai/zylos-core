/** Account scans enumerate all live sessions. Share their bounded cadence across
 * Dashboard readers while keeping live-only and recorded selection independent. */
export class AccountUsageCache {
  constructor({ ttlMs = 30000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.readers = new WeakMap();
  }

  async read(runtime, options, reader) {
    const read = reader.readAccountUsageSnapshot;
    let entries = this.readers.get(read);
    if (!entries) this.readers.set(read, entries = new Map());
    const key = runtime;
    const now = this.now();
    const cached = entries.get(key);
    let entry = cached;
    if (!cached || (!cached.pending && now - cached.sampledAt >= this.ttlMs)) {
      entry = { sampledAt: now, pending: true };
      entry.result = Promise.resolve().then(() => read(runtime))
        .catch(error => {
          // A transient failure must not suppress the next polling attempt.
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        })
        .finally(() => { entry.pending = false; });
      entries.set(key, entry);
    }
    const value = await entry.result;
    return options?.allowRecorded ? value.recorded : value.live;
  }
}

export const accountUsageCache = new AccountUsageCache();
