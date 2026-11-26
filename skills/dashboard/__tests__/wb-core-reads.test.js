import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { createCoreReads } from '../src/lib/workbench/core-reads.js';

const loadCoreModule = name => import(new URL(`../../../cli/lib/${name}`, import.meta.url));
const runtime = 'fixture-runtime';

// Read-only integration on a private C4 database under the runner's temporary root; no tmux, PM2, network or child
// process. Run when the snapshot's Core reads, Core's read-only store or the group/queue/override queries change;
// skip for presentation-only edits. Each fixture removes only its own root.
function fixture(t, { runtimeOverrides = 0, models = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-reads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const file = path.join(root, 'comm-bridge', 'c4.db');
  const db = new Database(file); guardDatabase(db, schema);
  const message = db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group,timestamp) VALUES('in','telegram',?,?,?,'2026-11-20 00:00:00')");
  const head = db.prepare('INSERT INTO group_heads VALUES(?,?)');
  const override = db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES(?,?)');
  const model = db.prepare('INSERT INTO group_model_overrides(session_group,runtime,model,effort) VALUES(?,?,?,?)');
  db.transaction(() => {
    for (const [group, status] of [['telegram:a', 'pending'], ['telegram:b', 'running'], ['origin', 'delivered']]) {
      head.run(group, message.run(`[Bot] hello ${group}`, status, group).lastInsertRowid);
    }
    for (let i = 0; i < runtimeOverrides; i++) override.run(`telegram:o${String(i).padStart(3, '0')}`, runtime);
    for (const group of models) model.run(group, runtime, 'fixture-model', 'high');
  })();
  const store = createStore(db);
  const expected = { groups: store.queries.listGroups(), queues: store.listGroupQueues(),
    raw: store.queries.listGroups({ keyMatch: 'telegram:a', limit: 1, raw: true }) };
  db.close();
  return { root, file, expected };
}

test('snapshot Core reads return Core\'s own results in process without changing the database', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const reads = createCoreReads({ zylosDir: f.root, loadCoreModule, now: () => 5 });
  assert.deepEqual(await reads.groups(), { ok: true, data: f.expected.groups, readAt: 5 });
  assert.deepEqual(await reads.groupQueues(), { ok: true, data: f.expected.queues, readAt: 5 });
  assert.deepEqual(await reads.groups({ keyMatch: 'telegram:a', limit: 1, raw: true }), { ok: true, data: f.expected.raw, readAt: 5 });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['c4.db'], 'a read-only connection leaves no journal files');
});

test('override reads cover every runtime override page and every requested group batch', async t => {
  // Two catalog pages, and more keys than one group batch holds: listed keys first, then catalog groups, then Origin.
  const listed = Array.from({ length: 500 }, (_, i) => `telegram:k${String(i).padStart(3, '0')}`);
  const f = fixture(t, { runtimeOverrides: 150, models: ['telegram:k000', 'telegram:o149', 'origin'] });
  const result = await createCoreReads({ zylosDir: f.root, loadCoreModule }).readOverrides([...listed, null, 'origin']);
  assert.equal(result.ok, true);
  assert.equal(result.data.runtime.length, 150);
  assert.equal(result.data.runtime.at(-1).sessionGroup, 'telegram:o149');
  assert.deepEqual(result.data.model.map(row => row.sessionGroup), ['telegram:k000', 'origin', 'telegram:o149']);
  assert.equal(typeof result.data.baseline.runtime, 'string');
});

test('a failed Core read reports its own reason and creates nothing', async t => {
  const root = path.join(fixture(t).root, 'missing');
  const reads = createCoreReads({ zylosDir: root, loadCoreModule, now: () => 7 });
  for (const [result, reason] of [[await reads.groups(), 'c4_groups_failed'], [await reads.groupQueues(), 'queue_summary_failed'],
    [await reads.readOverrides(['telegram:a']), 'override_list_failed']]) {
    assert.equal(result.ok, false); assert.equal(result.reason, reason); assert.equal(result.readAt, 7);
    assert.equal(typeof result.detail, 'string');
  }
  assert.equal(fs.existsSync(root), false);
});
