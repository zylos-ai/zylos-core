import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_DEPTH = 5000;
const DEFAULT_BATCH_SIZE = 25;

// Decouples ingest ACK from event processing (#260 phase 2). The hook POST is
// answered as soon as the event is queued; processing runs in batches with a
// setImmediate yield between batches so pending HTTP I/O interleaves. Under a
// hook storm the dashboard stays responsive and events render with at most a
// short delay instead of the whole event loop starving.
//
// Durability contract: a full queue refuses the push (handler answers 503 and
// the hook falls back to its spool file); a processing failure appends the raw
// body to the same spool for the periodic drainer to retry (insert dedupes on
// ingest_id); on graceful shutdown the remainder is dumped to the spool and
// replayed at next startup. Only a hard crash loses queued events.
export class IngestQueue {
  constructor({ process: processFn, spoolPath, maxDepth, batchSize, log } = {}) {
    this.processFn = processFn;
    this.spoolPath = spoolPath;
    this.maxDepth = maxDepth ?? DEFAULT_MAX_DEPTH;
    this.batchSize = batchSize ?? DEFAULT_BATCH_SIZE;
    this.log = log || (line => process.stderr.write(line));
    this.items = [];
    this.draining = false;
    this.stats = { queued_total: 0, processed_total: 0, failed_total: 0, dropped_total: 0, max_depth_seen: 0 };
  }

  get depth() {
    return this.items.length;
  }

  push(body) {
    if (this.items.length >= this.maxDepth) {
      this.stats.dropped_total++;
      return false;
    }
    this.items.push(body);
    this.stats.queued_total++;
    if (this.items.length > this.stats.max_depth_seen) this.stats.max_depth_seen = this.items.length;
    this._scheduleDrain();
    return true;
  }

  _scheduleDrain() {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => this._drainBatch());
  }

  _drainBatch() {
    const started = performance.now();
    let processed = 0;
    while (this.items.length && processed < this.batchSize) {
      const body = this.items.shift();
      processed++;
      try {
        this.processFn(body);
        this.stats.processed_total++;
      } catch (err) {
        this.stats.failed_total++;
        this.log(`[ingest-queue] process error, event sent to spool: ${err.message}\n`);
        this._appendToSpool([body]);
      }
      if (performance.now() - started >= 50) break;
    }
    if (this.items.length > 0) {
      setImmediate(() => this._drainBatch());
    } else {
      this.draining = false;
    }
  }

  snapshot() {
    return { depth: this.depth, ...this.stats };
  }

  // Graceful-shutdown path: hand unprocessed events to the hook spool so the
  // startup drain replays them.
  dumpToSpool() {
    if (!this.items.length) return 0;
    const count = this.items.length;
    this._appendToSpool(this.items);
    this.items = [];
    return count;
  }

  _appendToSpool(bodies) {
    if (!this.spoolPath) return;
    try {
      fs.mkdirSync(path.dirname(this.spoolPath), { recursive: true });
      fs.appendFileSync(this.spoolPath, bodies.map(b => JSON.stringify(b)).join('\n') + '\n');
    } catch (err) {
      this.log(`[ingest-queue] spool write failed, ${bodies.length} event(s) lost: ${err.message}\n`);
    }
  }
}
