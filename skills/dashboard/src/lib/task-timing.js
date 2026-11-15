import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const roundMs = value => Math.round(value * 10) / 10;

// Attribute elapsed synchronous JS segments, including continuations after await.
// This is elapsed time on the event-loop thread (including synchronous I/O), not
// CPU accounting. Async waiting contributes nothing. AsyncLocalStorage carries
// only a task name on live resources; no async-id/history map is retained here.
export class TaskTiming {
  constructor({ now = () => performance.now(), maxTasks = 64 } = {}) {
    this.now = now;
    this.maxTasks = Math.max(1, Math.floor(maxTasks));
    this.storage = new AsyncLocalStorage();
    this.records = new Map();
    this.stack = [];
    this.hook = createHook({
      before: id => {
        const name = this.storage.getStore();
        if (name !== undefined) this.enter(name, id);
      },
      after: id => {
        if (this.stack.at(-1)?.key === id) this.leave();
      }
    });
  }

  start() {
    this.hook.enable();
    return this;
  }

  stop() {
    this.hook.disable();
    this.storage.disable();
    this.stack.length = 0;
    this.records.clear();
  }

  run(name, fn) {
    // Keep log lines single-line and each retained label bounded in size.
    const label = String(name).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
    return this.storage.run(label, () => {
      this.enter(label, Symbol());
      try {
        // Deliberately do not await: before/after hooks measure each later
        // continuation independently and preserve Promise/exception semantics.
        return fn();
      } finally {
        this.leave();
      }
    });
  }

  enter(name, key) {
    const at = this.now();
    const parent = this.stack.at(-1);
    if (parent) this.record(parent.name, at - parent.started);
    this.stack.push({ name, key, started: at });
  }

  leave() {
    const at = this.now();
    const entry = this.stack.pop();
    if (entry) this.record(entry.name, at - entry.started);
    const parent = this.stack.at(-1);
    if (parent) parent.started = at;
  }

  record(name, duration) {
    const elapsed = Math.max(0, duration);
    let entry = this.records.get(name);
    if (!entry) {
      if (this.records.size >= this.maxTasks) {
        // Preserve the longest individual blockers when names exceed the cap.
        const shortest = [...this.records.values()].reduce((a, b) => a.max_ms <= b.max_ms ? a : b);
        if (elapsed <= shortest.max_ms) return;
        this.records.delete(shortest.name);
      }
      entry = { name, total_ms: 0, max_ms: 0, segments: 0 };
      this.records.set(name, entry);
    }
    entry.total_ms += elapsed;
    entry.max_ms = Math.max(entry.max_ms, elapsed);
    entry.segments++;
  }

  drain(at = this.now(), limit = 5) {
    const active = this.stack.at(-1);
    if (active) {
      this.record(active.name, at - active.started);
      active.started = at;
    }
    const result = [...this.records.values()]
      .sort((a, b) => b.max_ms - a.max_ms || b.total_ms - a.total_ms)
      .slice(0, limit)
      .map(entry => ({ ...entry, total_ms: roundMs(entry.total_ms), max_ms: roundMs(entry.max_ms) }));
    this.records.clear();
    return result;
  }
}
