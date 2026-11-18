import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture as databaseFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { getMaxConversationId } from '../skills/comm-bridge/scripts/c4-db.js';
import { GlobalMemoryHandoverCoordinator } from '../skills/activity-monitor/scripts/global-memory-handover.js';
import { withMemoryLock } from '../skills/zylos-memory/scripts/sync-lock.js';
import { appendInbox } from '../skills/zylos-memory/scripts/memory-append.js';

const worker = fileURLToPath(new URL('../skills/activity-monitor/scripts/__tests__/fixtures/global-memory-handover-worker.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-integration-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const { db, store, filename } = databaseFixture(t, {}, true);
  const memory = path.join(root, 'memory'); fs.mkdirSync(memory);
  fs.writeFileSync(path.join(memory, 'state.md'), 'old single working state');
  fs.writeFileSync(path.join(memory, 'inbox.md'), 'global inbox');
  db.prepare("INSERT INTO mode_transitions(run_id,kind,source_mode,target_mode,phase,cutoff,created_at,updated_at) VALUES('old-single','switch','multi','single','complete',0,100,101)").run();
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES(8,'in','test','a','old message','delivered','group-a')").run();
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES(19,'in','test','b','origin message','delivered','origin')").run();
  db.prepare("INSERT INTO checkpoints(start_conversation_id,end_conversation_id,summary,session_group) VALUES(1,8,'old summary','*')").run();
  const api = { ...store, getMaxConversationId: () => getMaxConversationId(db) };
  const deps = { zylosDir: root, db: api, readMode: () => ({ keyPresent: true, mode: 'multi' }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [] };
  const snapshot = () => Object.fromEntries(['mode_transitions', 'drain_fences', 'conversations', 'checkpoints', 'origin_sync_cursors', 'run_endings'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  return { root, memory, db, store, filename, deps, snapshot, owner: () => new GlobalMemoryHandoverCoordinator(deps) };
}

for (const point of ['before-plan', 'plan', 'rename', 'append', 'enqueue', 'before-done']) test(`actual SIGKILL after ${point} recovers through real C4 and memory append without transition writes`, async t => {
  const f = fixture(t), before = f.snapshot();
  const crashed = spawnSync(process.execPath, [worker, f.root, f.filename, point], { encoding: 'utf8', timeout: 10000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const dirs = fs.readdirSync(path.join(f.memory, 'mode-switch')); assert.equal(dirs.length, 1);
  const id = dirs[0], archive = path.join(f.memory, 'mode-switch', id, 'previous/_global');
  assert.equal(fs.existsSync(path.join(archive, '.done')), false);
  const planPath = path.join(f.memory, 'mode-switch', id, 'plan.json'); const saved = point === 'before-plan' ? null : fs.readFileSync(planPath, 'utf8');
  if (saved) assert.deepEqual(JSON.parse(saved).interval, { B: 8, M: 19 });
  const owner = f.owner(); assert.equal(owner.pending(), true); const plan = await owner.advance();
  assert.equal(plan.id, id); assert.equal(owner.pending(), false); if (saved) assert.equal(fs.readFileSync(planPath, 'utf8'), saved);
  assert.deepEqual(plan.interval, { B: 8, M: 19 });
  assert.equal(fs.existsSync(path.join(archive, '.done')), true);
  assert.equal(fs.readFileSync(path.join(archive, 'state.md'), 'utf8'), 'old single working state');
  assert.equal(fs.readFileSync(path.join(archive, 'inbox.md'), 'utf8'), 'global inbox');
  const inbox = fs.readFileSync(path.join(f.memory, 'session-groups/origin/inbox.md'), 'utf8');
  assert.match(inbox, /C4 interval \(8, 19\]/);
  assert.equal([...inbox.matchAll(/commitment:/g)].length, ['append', 'enqueue', 'before-done'].includes(point) ? 2 : 1);
  const controls = f.db.prepare("SELECT * FROM control_queue WHERE status='pending'").all();
  assert.equal(controls.length, 1); assert.equal(controls[0].session_group, 'origin');
  assert.equal(controls[0].target_binding, null); assert.equal(controls[0].priority, 2); assert.equal(controls[0].ack_deadline_at, null);
  assert.doesNotMatch(controls[0].content, /ack via/); assert.match(controls[0].content, new RegExp(id.replaceAll('.', '\\.')));
  assert.deepEqual(f.snapshot(), before);
});

test('real Origin memory lock timeout releases lifecycle queue and next pass resumes', async t => {
  const f = fixture(t), events = []; f.deps.waitMs = 20; f.deps.diagnostic = event => events.push(event);
  let release, acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const held = withMemoryLock(path.join(f.root, 'activity-monitor/session-groups/origin'), async () => {
    acquired(); await new Promise(resolve => { release = resolve; });
  });
  await ready;
  try {
    const owner = f.owner(), result = await owner.advance(); assert.equal(result.code, 'LOCK_TIMEOUT');
    assert.equal(events.at(-1).event, 'global_memory_handover_failed'); assert.equal(owner.pending(), true);
  } finally { release(); await held; }
  assert.equal((await f.owner().advance()).rule, 3); assert.equal(f.owner().pending(), false);
});

test('handover and ordinary concurrent Origin append share lock and preserve complete entries', async t => {
  const f = fixture(t); const env = { ZYLOS_DIR: f.root, ZYLOS_SESSION_GROUP: 'origin' };
  const results = await Promise.all([f.owner().advance(), appendInbox({ kind: 'fact', content: 'ordinary Origin entry', env })]);
  assert.equal(results[0].rule, 3);
  const inbox = fs.readFileSync(path.join(f.memory, 'session-groups/origin/inbox.md'), 'utf8');
  assert.equal([...inbox.matchAll(/commitment:/g)].length, 1); assert.equal([...inbox.matchAll(/fact: ordinary Origin entry/g)].length, 1);
  assert.equal(inbox.split('\n').filter(line => line.startsWith('- ')).length, 2);
});
