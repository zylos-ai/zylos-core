import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncObserver } from '../sync-observer.js';
import { SyncAlertEpisodes } from '../sync-alert-episodes.js';
import { appendEvent, rotateEventLog } from '../../../../cli/lib/event-log.js';
import { supervisorDiagnosticPath } from '../../../../cli/lib/session-group-paths.js';
import { renderStateSkeleton } from '../../../zylos-memory/scripts/state-format.js';

// Module tests use only a private temporary log/state tree and in-memory
// database observations. No runtime, network, tmux or live database is opened.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root }, file = supervisorDiagnosticPath(env);
  let clock = 1800000000000;
  const f = { root, file, env, checkpoints: new Map(), ranges: new Map(), controls: new Map(), scopes: [] };
  f.db = { getLatestContentCheckpoint: scope => f.checkpoints.get(scope),
    getControlById: id => f.controls.get(id),
    getUnsummarizedRange: scope => f.ranges.get(scope) ?? { count: 0, firstAt: null },
    getGlobalUnsummarizedRange: () => f.ranges.get('*') ?? { count: 0, firstAt: null } };
  f.event = row => appendEvent(file, { v: 1, ts: clock, ...row });
  f.trigger = (extra = {}) => f.event({ event: 'sync_triggered', kind: 'group', scope: 'origin', checkpointId: null, ...extra });
  f.create = () => { const observer = new SyncObserver({ env, now: () => clock }); t.after(() => observer.close()); return observer; };
  f.advance = ms => { clock += ms; };
  f.now = () => clock;
  f.inspect = observer => observer.inspect(f.db, { mode: 'multi', activeScopes: ['origin'] });
  return f;
}

test('three requests without a checkpoint alert and a new checkpoint resets the episode across restart', async t => {
  const f = fixture(t); f.trigger(); f.trigger();
  let observer = f.create(); assert.equal((await f.inspect(observer)).length, 0);
  f.trigger(); assert.equal((await f.inspect(observer))[0].type, 'no_checkpoint');
  observer.close(); observer = f.create();
  assert.equal((await f.inspect(observer))[0].attempts, 3);
  f.checkpoints.set('origin', { id: 1, end_conversation_id: 0 });
  const dir = path.join(f.root, 'memory/session-groups/origin'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.md'), renderStateSkeleton({ scope: 'origin', syncedAt: '2026-11-17T00:00:00Z' }).replace('coverage= |', 'coverage=0 |'));
  assert.equal((await f.inspect(observer)).length, 0);
  f.trigger({ checkpointId: 1 });
  assert.equal((await f.inspect(observer)).length, 0);
});

test('Origin frequency needs five triggers inside the last hour', async t => {
  const f = fixture(t), observer = f.create();
  for (let i = 0; i < 4; i++) f.trigger({ kind: 'origin' });
  assert.equal((await f.inspect(observer)).length, 0);
  f.trigger({ kind: 'origin' }); assert.equal((await f.inspect(observer))[0].type, 'origin_frequency');
  f.advance(3600001); assert.equal((await f.inspect(observer)).length, 0);
});

test('Origin idle alert needs more than five truly empty rounds out of ten', async t => {
  const f = fixture(t), observer = f.create();
  const result = empty => f.event({ event: 'sync_result', kind: 'origin', action: 'round_complete', processedCount: 0, advancedGroups: empty ? 0 : 1 });
  for (let i = 0; i < 5; i++) result(true);
  for (let i = 0; i < 5; i++) result(false);
  assert.equal((await f.inspect(observer)).length, 0, 'summary-only advances do useful work');
  result(true); result(true); result(true); result(true); result(true); result(true);
  assert.equal((await f.inspect(observer))[0].type, 'origin_idle');
});

test('inactive group lag stays silent while timeout diagnostics retain their kind', async t => {
  const f = fixture(t), observer = f.create();
  f.scopes = ['telegram:inactive', 'origin'];
  f.ranges.set('telegram:inactive', { count: 1, firstAt: f.now() - 21600000 });
  assert.equal((await f.inspect(observer)).length, 0);
  f.advance(1);
  f.trigger({ scope: 'telegram:inactive', controlId: 17 }); f.controls.set(17, { status: 'timeout' });
  const alerts = await f.inspect(observer);
  assert.equal(alerts.length, 1);
  assert.equal(alerts.some(row => row.type === 'backlog'), false);
  assert.ok(alerts.some(row => row.type === 'control_timeout' && row.controlId === 17));
  assert.equal((await f.inspect(observer)).filter(row => row.type === 'control_timeout').length, 1, 'blocked delivery retains evidence');
  observer.acknowledged(alerts.find(row => row.type === 'control_timeout'));
  assert.equal((await f.inspect(observer)).filter(row => row.type === 'control_timeout').length, 0);
});

test('checkpoint-state gap alerts after marker release and clears after publication', async t => {
  const f = fixture(t), observer = f.create(); f.scopes = ['origin'];
  f.checkpoints.set('origin', { id: 3, end_conversation_id: 20 });
  assert.equal((await observer.inspect(f.db, { mode: 'multi', activeScopes: ['origin'] }, () => true)).length, 0);
  assert.equal((await f.inspect(observer))[0].type, 'state_uncommitted');
  const dir = path.join(f.root, 'memory/session-groups/origin'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.md'), renderStateSkeleton({ scope: 'origin', syncedAt: '2026-11-17T00:00:00Z' }).replace('coverage= |', 'coverage=20 |'));
  assert.equal((await f.inspect(observer)).length, 0);
});

test('rotated logs preserve the third trigger and distinguish global from group', async t => {
  const f = fixture(t), observer = f.create(); f.trigger(); f.trigger(); await f.inspect(observer);
  rotateEventLog(f.file, { maxBytes: 1, now: f.now() }); f.trigger();
  const alerts = await f.inspect(observer); assert.equal(alerts[0].type, 'no_checkpoint');
  f.trigger({ kind: 'global', scope: '*' });
  assert.equal((await f.inspect(observer)).filter(row => row.kind === 'global').length, 0);
});


test('restart recovers timeout evidence beyond the checkpoint trigger window', async t => {
  const f = fixture(t);
  f.trigger({ controlId: 1 }); f.controls.set(1, { status: 'timeout' });
  for (let id = 2; id <= 9; id++) { f.trigger({ controlId: id }); f.controls.set(id, { status: 'done' }); }
  const alerts = await f.inspect(f.create());
  assert.equal(alerts.filter(row => row.type === 'control_timeout').length, 1);
  assert.equal(alerts.find(row => row.type === 'control_timeout').controlId, 1);
});


test('failed recovery observation retries retained evidence on the next poll', async t => {
  const f = fixture(t); f.trigger({ controlId: 1 }); f.controls.set(1, { status: 'timeout' });
  const observer = f.create(), get = f.db.getControlById;
  f.db.getControlById = () => { throw new Error('database unavailable'); };
  await assert.rejects(f.inspect(observer), /database unavailable/);
  f.db.getControlById = get;
  assert.equal((await f.inspect(observer)).find(row => row.type === 'control_timeout').controlId, 1);
});

// Run for timeout recovery/acknowledgment changes; skip unrelated UI or prompts.
// These cases use the fixture's private event log and in-memory database only.
test('durable episode claims replace log-based timeout acknowledgments across restart', async t => {
  const f = fixture(t);
  const createStore = () => new SyncAlertEpisodes({ env: f.env, now: f.now });
  let store = createStore(), observer = f.create();
  f.trigger({ controlId: 1 }); f.controls.set(1, { status: 'timeout' });
  const alerts = await f.inspect(observer);
  const timeout = alerts.find(row => row.type === 'control_timeout');
  assert.equal(store.claim(timeout), true);
  observer.acknowledged(timeout);
  observer.close(); observer = f.create(); store = createStore();
  assert.equal(store.reconcile({ active: await f.inspect(observer) }).filter(row => row.type === 'control_timeout').length, 0);
  f.trigger({ controlId: 3 }); f.controls.set(3, { status: 'timeout' });
  assert.equal(store.reconcile({ active: await f.inspect(observer) }).find(row => row.type === 'control_timeout').controlId, 3);
  // A lower-ID control may finish later; an ID watermark must not hide it.
  f.trigger({ controlId: 0 }); f.controls.set(0, { status: 'timeout' });
  assert.ok(store.reconcile({ active: await f.inspect(observer) }).some(row => row.type === 'control_timeout' && row.controlId === 0));
});

test('maximum lag does not alert for active or inactive group scopes', async t => {
  const f = fixture(t), observer = f.create(); f.scopes = ['active', 'inactive'];
  for (const scope of f.scopes) f.ranges.set(scope, { count: 1, firstAt: f.now() - 21600001 });
  const alerts = await observer.inspect(f.db, { mode: 'multi', activeScopes: ['active'] });
  assert.deepEqual(alerts, []);
});

// Real diagnostic reader, episode file and state parser in private fixture roots.
// Run for alert recovery/resolution changes; skip unrelated UI or prompts.
test('missing trigger evidence never resolves a persisted no-checkpoint episode', async t => {
  const f = fixture(t), store = new SyncAlertEpisodes({ env: f.env, now: f.now });
  const alert = { type: 'no_checkpoint', kind: 'group', scope: 'origin', checkpointId: 3 };
  assert.equal(store.claim(alert), true);
  f.advance(9 * 86400000);
  const observer = f.create();
  f.checkpoints.set('origin', { id: 3 });
  await observer.inspect(f.db, { mode: 'multi', episodes: store.entries() });
  store.reconcile({ resolved: observer.resolved });
  assert.equal(store.claim(alert), false);
  f.checkpoints.delete('origin');
  await observer.inspect(f.db, { mode: 'multi', episodes: store.entries() });
  assert.equal(observer.resolved.some(row => row.type === 'no_checkpoint'), false);
  f.checkpoints.set('origin', { id: 4 });
  await observer.inspect(f.db, { mode: 'multi', episodes: store.entries() });
  store.reconcile({ resolved: observer.resolved });
  assert.equal(store.claim({ ...alert, checkpointId: 4 }), true);
});

test('backlog and state episodes require observed progress rather than a live session or held marker', async t => {
  const f = fixture(t), observer = f.create(); f.scopes = ['origin'];
  f.ranges.set('origin', { count: 900, firstAt: f.now() - 21600001 });
  f.checkpoints.set('origin', { id: 3, end_conversation_id: 20 });
  await observer.inspect(f.db, { mode: 'multi', activeScopes: ['origin'] }, () => true);
  assert.equal(observer.resolved.some(row => ['backlog', 'state_uncommitted'].includes(row.type)), false);
  f.ranges.set('origin', { count: 1, firstAt: f.now() });
  await f.inspect(observer);
  assert.equal(observer.resolved.some(row => row.type === 'backlog'), true);
  assert.equal(observer.resolved.some(row => row.type === 'state_uncommitted'), false);
  const dir = path.join(f.root, 'memory/session-groups/origin'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.md'), renderStateSkeleton({ scope: 'origin', syncedAt: '2026-11-17T00:00:00Z' }).replace('coverage= |', 'coverage=20 |'));
  await observer.inspect(f.db, { mode: 'multi', activeScopes: ['origin'] }, () => true);
  assert.equal(observer.resolved.some(row => row.type === 'state_uncommitted'), true);
});

test('Origin frequency and idle episodes resolve only when their observed windows recover', async t => {
  const f = fixture(t), observer = f.create();
  for (let i = 0; i < 5; i++) f.trigger({ kind: 'origin' });
  for (let i = 0; i < 10; i++) f.event({ event: 'sync_result', kind: 'origin', action: 'round_complete', processedCount: 0, advancedGroups: 0 });
  await f.inspect(observer);
  assert.equal(observer.resolved.some(row => row.type.startsWith('origin_')), false);
  f.advance(3600001);
  for (let i = 0; i < 5; i++) f.event({ event: 'sync_result', kind: 'origin', action: 'round_complete', processedCount: 1, advancedGroups: 1 });
  await f.inspect(observer);
  assert.deepEqual(observer.resolved.filter(row => row.type.startsWith('origin_')).map(row => row.type), ['origin_frequency', 'origin_idle']);
});

test('old handled timeout controls stay suppressed without a diagnostic-log recovery cutoff', async t => {
  const f = fixture(t);
  f.trigger({ controlId: 10 }); f.controls.set(10, { status: 'timeout' });
  f.trigger({ controlId: 9 }); f.controls.set(9, { status: 'timeout' });
  const handled = { type: 'control_timeout', kind: 'group', scope: 'origin', controlId: 10 };
  assert.equal(new SyncAlertEpisodes({ env: f.env }).claim(handled), true);
  f.advance(9 * 86400000);
  const store = new SyncAlertEpisodes({ env: f.env }), observer = f.create();
  const alerts = store.reconcile({ active: await f.inspect(observer), resolved: observer.resolved });
  assert.deepEqual(alerts.filter(row => row.type === 'control_timeout').map(row => row.controlId), [9]);
});

// Private event/state fixture only. Run for dormant-scope observation policy.
test('dormant checkpoint and repeated requests stay silent until the group is active', async t => {
  const f = fixture(t), observer = f.create();
  const scope = 'telegram:dormant';
  f.scopes = [scope];
  f.checkpoints.set(scope, { id: 3, end_conversation_id: 20 });
  f.ranges.set(scope, { count: 1, firstAt: f.now() - 21600001 });
  for (let i = 0; i < 3; i++) f.trigger({ scope, checkpointId: 3 });
  assert.deepEqual(await observer.inspect(f.db, { mode: 'multi', activeScopes: [] }), []);
  const alerts = await observer.inspect(f.db, { mode: 'multi', activeScopes: [scope] });
  assert.deepEqual(alerts.map(row => row.type).sort(), ['no_checkpoint', 'state_uncommitted']);
});
