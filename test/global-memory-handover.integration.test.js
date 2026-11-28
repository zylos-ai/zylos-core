import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture as databaseFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { GlobalMemoryHandoverCoordinator } from '../skills/activity-monitor/scripts/global-memory-handover.js';
const worker = fileURLToPath(new URL('./fixtures/global-memory-handover-worker.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-integration-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const { db, store, filename } = databaseFixture(t, {}, true);
  const memory = path.join(root, 'memory'); fs.mkdirSync(memory);
  fs.writeFileSync(path.join(memory, 'inbox.md'), 'global inbox');
  db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,cutoff,created_at,updated_at) VALUES('old-migration','single','multi','complete',0,100,101)").run();
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES(8,'in','test','a','old message','delivered','group-a')").run();
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES(19,'in','test','b','origin message','delivered','origin')").run();
  db.prepare("INSERT INTO checkpoints(start_conversation_id,end_conversation_id,summary,session_group) VALUES(1,8,'old summary','*')").run();
  const deps = { zylosDir: root, db: store, readMode: () => ({ keyPresent: true, mode: 'multi' }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [] };
  const snapshot = () => Object.fromEntries(['mode_transitions', 'drain_fences', 'conversations', 'checkpoints', 'origin_sync_cursors', 'run_endings'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  return { root, memory, db, store, filename, deps, snapshot, owner: () => new GlobalMemoryHandoverCoordinator(deps) };
}

// Boundary: an isolated C4 database plus durable archive and queue writes.
// Run for cutover/archive recovery changes. No runtime or external service starts.
for (const point of ['before-plan', 'plan', 'rename', 'enqueue']) test(`actual SIGKILL after ${point} recovers through the archive and real C4 queue`, async t => {
  const f = fixture(t), before = f.snapshot();
  const completedAt = f.db.prepare("SELECT updated_at FROM mode_transitions WHERE run_id='old-migration'").pluck().get();
  fs.utimesSync(path.join(f.memory, 'inbox.md'), completedAt - 1, completedAt - 1);
  const crashed = spawnSync(process.execPath, [worker, f.root, f.filename, point], { encoding: 'utf8', timeout: 10000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const dirs = fs.readdirSync(path.join(f.memory, 'mode-switch')); assert.equal(dirs.length, 1);
  const id = dirs[0], archive = path.join(f.memory, 'mode-switch', id, 'previous/_global');
  assert.equal(fs.existsSync(path.join(archive, '.done')), false);
  const planPath = path.join(f.memory, 'mode-switch', id, 'plan.json'); const saved = point === 'before-plan' ? null : fs.readFileSync(planPath, 'utf8');
  if (saved) assert.equal(JSON.parse(saved).interval, undefined);
  const owner = f.owner(); assert.equal(owner.pending(), true); const plan = await owner.advance();
  assert.equal(plan.id, id); assert.equal(owner.pending(), false); if (saved) assert.equal(fs.readFileSync(planPath, 'utf8'), saved);
  assert.equal(plan.interval, undefined);
  assert.equal(fs.existsSync(path.join(archive, '.done')), true);
  assert.equal(fs.readFileSync(path.join(archive, 'inbox.md'), 'utf8'), 'global inbox');
  assert.equal(fs.existsSync(path.join(f.memory, 'session-groups/origin/inbox.md')), false);
  const controls = f.db.prepare("SELECT * FROM control_queue WHERE status='pending'").all();
  assert.equal(controls.length, 1); assert.equal(controls[0].session_group, 'origin');
  assert.equal(controls[0].target_binding, null); assert.equal(controls[0].priority, 2); assert.equal(controls[0].ack_deadline_at, null);
  assert.doesNotMatch(controls[0].content, /ack via/); assert.match(controls[0].content, new RegExp(id.replaceAll('.', '\\.')));
  assert.deepEqual(f.snapshot(), before);
});
