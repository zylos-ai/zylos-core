import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { routerFixture } from './helpers/router-fixture.js';
import { SupervisorRunEndings } from '../../../activity-monitor/scripts/supervisor-run-endings.js';
import { groupRunDir } from '../../../../cli/lib/session-group-paths.js';

// Cross-module boundary: persistent current-session file -> Supervisor reconciliation -> real C4
// records/marker -> Router activation. Run for changes to any of these contracts;
// official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR. The fixture
// owns its temporary current-session files and memory SQLite; runtime/clock I/O
// is injected, no daemon/tmux/network is used, and teardown stops the router and
// closes/removes the owned resources. Skip unrelated UI changes.
test('a restarted supervisor resumes an absent group through the persistent continuation exactly once', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continue-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root };
  const f = routerFixture(t);
  f.put('origin');
  const message = f.add('team');
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(message.id);
  const group = message.session_group;
  f.db.takeSlot(group, { runId: 'old-run', k: 2 });
  const directory = groupRunDir(group, env);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'current-session.json'), JSON.stringify({ runId: 'old-run', sessionId: 'old-session', ts: f.now() - 10000 }));
  const context = { configuration: { mode: 'multi' }, transition: null, fences: [], scenes: [] };
  const supervisor = () => new SupervisorRunEndings({ db: f.db, env, now: f.now,
    readIdentity: f.deps.readLiveIdentity, diagnostic: () => {}, reportError: error => { throw error; } });
  // A new instance has no earlier scene sample or in-memory exit history.
  await supervisor().advance(context);
  const record = f.db.listRunEndings(['team', 'gated-upgrade'])[0];
  assert.equal(record.runId, 'old-run'); assert.equal(record.reason, 'unexpected');
  assert.equal(record.continuationPending, 1);
  assert.equal(f.db.listPendingContinuations().length, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
  f.create(); await f.router.initialize(); await f.rounds(2);
  f.advance(5000); await f.rounds(5);
  const launches = () => f.calls.filter(call => call[0] === 'launch' && call[1].sessionGroup === group);
  assert.equal(launches().length, 1);
  assert.equal(f.db.listRunEndings([group])[0].continuationPending, 0);
  assert.equal(f.calls.filter(call => call[0] === 'control').length, 0);
  assert.equal(f.events.filter(event => event.event === 'continuation_cleared' && event.session_group === group).length, 1);
  await supervisor().advance(context); await f.rounds(3);
  assert.equal(launches().length, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  // A subsequent normal idle ending is recorded without another continuation.
  const runId = launches()[0][1].runId;
  f.db.setDrainFence(group, { reason: 'ttl', runId });
  f.db.recordRunEnd(group, { runId, reason: 'ttl', clearFence: true });
  f.scene.delete(group);
  await fs.writeFile(path.join(directory, 'current-session.json'), JSON.stringify({ runId, sessionId: 'new-session', ts: f.now() }));
  await supervisor().advance(context);
  f.advance(120000); await f.rounds(4);
  assert.equal(launches().length, 1);
  assert.equal(f.db.listRunEndings(['team', 'gated-upgrade'])[0].reason, 'ttl');
  assert.equal(f.db.listRunEndings([group])[0].continuationPending, 0);
});

// Native single reconciliation -> real Store wake demand -> real Router launch.
// Run for mode eligibility/continuation wiring; skip unrelated UI. The official
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; private session files and
// in-memory SQLite only. Launch and clock are injected, no tmux/process/network;
// fixture teardown stops Router and closes/removes its resources.
test('native single restarts a missing Origin while only pruning ordinary occupancy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-continue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root };
  const f = routerFixture(t, { mode: 'single' });
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: ':memory:', tmux: 'not used' }));
  // A running row left by multi before switching to native single.
  f.sqlite.prepare("INSERT INTO slot_occupancy(session_group,run_id,state,held_until,created_at) VALUES('old-group','old-group-run','running',NULL,?)").run(f.now() / 1000);
  const directory = groupRunDir('origin', env);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'current-session.json'), JSON.stringify({ runId: 'origin-crash', ts: f.now() - 1000 }));
  const reads = [];
  const supervisor = new SupervisorRunEndings({ db: f.db, env, now: f.now,
    readFile: (file, ...args) => { reads.push(path.basename(path.dirname(file))); return fs.readFile(file, ...args); },
    readIdentity: f.deps.readLiveIdentity, reportError: error => { throw error; } });
  const context = { configuration: { mode: 'single', legacy: false }, scenes: [] };
  f.advance(31000);
  await supervisor.advance(context);
  const ending = f.db.listRunEndings(['origin'])[0];
  assert.equal(ending?.runId, 'origin-crash');
  assert.equal(ending.reason, 'unexpected');
  assert.equal(ending.continuationPending, 1);
  assert.equal(f.db.getOriginNeed(f.now() / 1000, { sessionMode: 'single' }).continuation.pending, true);
  assert.equal(f.db.listRunEndings(['old-group']).length, 0);
  assert.deepEqual(reads, ['origin']);
  assert.equal(f.db.listSlotOccupancy().length, 0);
  f.create();
  await f.router.initialize();
  await f.rounds(2);
  f.advance(5000);
  await f.rounds(5);
  const launches = () => f.calls.filter(call => call[0] === 'launch' && call[1].sessionGroup === 'origin');
  assert.equal(launches().length, 1);
  assert.equal(f.db.listRunEndings(['origin'])[0].continuationPending, 0);
  await supervisor.advance(context);
  await f.rounds(3);
  assert.equal(launches().length, 1);
});
