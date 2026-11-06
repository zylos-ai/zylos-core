import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../../src/lib/store.js';
import { C4Reader } from '../../src/lib/c4-reader.js';

export function usageFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  fs.mkdirSync(path.join(dir, 'comm-bridge'));
  const c4 = new Database(path.join(dir, 'comm-bridge/c4.db'));
  c4.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, timestamp TEXT, direction TEXT)');
  const reader = new C4Reader(dir);
  t.after(() => { reader.close(); c4.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let sequence = 0;
  return { store, reader, c4,
    metric(timestamp, runtime, dimensions, metricName = 'usage_event', value = 9999) {
      store.insertMetric({ timestamp, runtime, session_id: `session-${++sequence}`,
        session_group: runtime === 'claude' ? 'telegram:a' : 'telegram:b',
        metric_name: metricName, metric_value: value, dimensions, source: 'jsonl_usage', confidence: 'actual' });
    },
    event(timestamp, type, metadata = {}) {
      const id = `event-${++sequence}`;
      store.insertEvent({ id, ingest_id: id, timestamp, runtime: 'claude',
        event_type: type, category: 'lifecycle', metadata });
    },
    message(timestamp, direction) { c4.prepare('INSERT INTO conversations(timestamp,direction) VALUES(?,?)').run(timestamp, direction); }
  };
}
