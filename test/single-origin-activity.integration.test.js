import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { createGroupSnapshot } from '../skills/dashboard/src/lib/workbench/group-snapshot.js';
import { collectStatus } from '../cli/lib/status-view.js';

// Actual Store -> snapshot -> activity buckets, with inert Core observations.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR before import.
// No network, subprocess, tmux socket or live runtime starts; close the private
// database before removing this fixture, including after an assertion failure.
for (const range of ['60m', '6h']) test(`single Origin ${range} discovers a legacy run from only null-group window events`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-activity-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Origin activity isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: store.db.name,
    network: 'none', subprocess: 'none', tmux: 'none' }));
  const now = 1800000000000, width = range === '60m' ? 60000 : 300000;
  const start = Math.floor(now / width) * width - (range === '60m' ? 59 : 71) * width;
  for (const [id, type, at] of [
    ['prompt', 'user_prompt_submit', start - width], ['stop', 'stop', start + width],
  ]) store.insertEvent({ id, ingest_id: id, timestamp: new Date(at).toISOString(), runtime: 'claude',
    session_group: null, run_id: 'legacy-only', event_type: type, category: 'activity' });
  const observation = { identity: { present: false },
    status: { valid: false, reason: 'not_running' }, usage: { valid: false } };
  const sessionObservations = {
    get: async () => ({ mode: 'single', group: null, observations: new Map([[null, observation]]) }),
    reader: { readRuntimeHealth: () => ({ missing: true }), readAccountUsage: async () => null },
  };
  const service = createGroupSnapshot({ zylosDir: root, store, now: () => now, sessionObservations,
    c4Reader: { getInboundTimes: () => [] },
    cli: { runC4Db: async () => ({ ok: true, data: { groups: [], hasOlder: false } }),
      readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) },
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode: 'single' }) };
      if (name === 'status-view.js') return { collectStatus: options => collectStatus({ ...options,
        mode: () => ({ mode: 'single' }), resolveRoot: () => root, now: () => now,
        requests: () => ({}), configIssue: () => null, facts: () => ({ originNeed: null }),
        health: () => ({ missing: true }), list: () => [] }) };
      throw new Error('Unavailable fixture source: ' + name);
    },
  });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.rows[0].sessionGroup, null);
  assert.equal(snapshot.rows[0].live?.runId ?? null, null);
  const result = await service.activity(range);
  assert.deepEqual(Object.keys(result.groups), ['origin']);
  assert.equal(result.groups.origin.cells[0], 'busy', 'the null-group stop discovers its run and seeds the earlier prompt');
  assert.equal(result.groups.origin.cells[1], 'none', 'the stop at the next boundary ends the seeded turn');
  assert.equal(result.groups.origin.cells[2], 'none');
});
