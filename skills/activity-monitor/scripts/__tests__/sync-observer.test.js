import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncObserver } from '../sync-observer.js';
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
    getControlById: id => f.controls.get(id), listGroupHeads: () => f.scopes.map(sessionGroup => ({ sessionGroup })),
    getUnsummarizedRange: scope => f.ranges.get(scope) ?? { count: 0, firstAt: null },
    getGlobalUnsummarizedRange: () => f.ranges.get('*') ?? { count: 0, firstAt: null } };
  f.event = row => appendEvent(file, { v: 1, ts: clock, ...row });
  f.trigger = (extra = {}) => f.event({ event: 'sync_triggered', kind: 'group', scope: 'origin', checkpointId: null, ...extra });
  f.create = () => { const observer = new SyncObserver({ env, now: () => clock }); t.after(() => observer.close()); return observer; };
  f.advance = ms => { clock += ms; };
  f.now = () => clock;
  f.inspect = observer => observer.inspect(f.db, { mode: 'multi' });
  return f;
}

test('three requests without a checkpoint alert and a new checkpoint resets the episode across restart', async t => {
  const f = fixture(t); f.trigger(); f.trigger();
  let observer = f.create(); assert.equal((await f.inspect(observer)).length, 0);
  f.trigger(); assert.equal((await f.inspect(observer))[0].type, 'no_checkpoint');
  observer.close(); observer = f.create();
  assert.equal((await f.inspect(observer))[0].attempts, 3);
  f.checkpoints.set('origin', { id: 1 });
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

test('inactive groups are inspected at the configured lag boundary and timeouts retain their kind', async t => {
  const f = fixture(t), observer = f.create();
  f.scopes = ['telegram:inactive', 'origin'];
  f.ranges.set('telegram:inactive', { count: 1, firstAt: f.now() - 21600000 });
  assert.equal((await f.inspect(observer)).length, 0);
  f.advance(1);
  f.trigger({ scope: 'telegram:inactive', controlId: 17 }); f.controls.set(17, { status: 'timeout' });
  const alerts = await f.inspect(observer);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.some(row => row.type === 'backlog' && row.kind === 'group' && row.scope === 'telegram:inactive'));
  assert.ok(alerts.some(row => row.type === 'control_timeout' && row.controlId === 17));
  assert.equal((await f.inspect(observer)).filter(row => row.type === 'control_timeout').length, 1, 'blocked delivery retains evidence');
  observer.acknowledged(alerts.find(row => row.type === 'control_timeout'));
  assert.equal((await f.inspect(observer)).filter(row => row.type === 'control_timeout').length, 0);
});

test('checkpoint-state gap alerts after marker release and clears after publication', async t => {
  const f = fixture(t), observer = f.create(); f.scopes = ['origin'];
  f.checkpoints.set('origin', { id: 3, end_conversation_id: 20 });
  assert.equal((await observer.inspect(f.db, { mode: 'multi' }, () => true)).length, 0);
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
