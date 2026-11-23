import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store } from '../src/lib/store.js';

function tmpDir(prefix = 'metric-collectors-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withStore(fn) {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('usage_event unique index deduplicates null-session replay keys atomically', () => withStore((store) => {
  const point = {
    timestamp: new Date().toISOString(),
    runtime: 'codex',
    session_id: null,
    metric_name: 'usage_event',
    metric_value: 100,
    dimensions: { event_id: 'token-count-null-session', input: 100 },
    source: 'jsonl_usage',
    confidence: 'actual'
  };

  assert.deepEqual(store.insertMetricOnce(point), { inserted: true, changes: 1 });
  assert.deepEqual(store.insertMetricOnce(point), { inserted: false, changes: 0 });
  assert.equal(store.queryMetrics({ name: 'usage_event' }).length, 1);
}));
