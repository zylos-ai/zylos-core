import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorServerHealth } from '../supervisor-server-health.js';
import { SupervisorServerObservation, parseServerAlertTarget } from '../supervisor-server-observation.js';
const unavailable = () => Object.assign(new Error('timeout'), { code: 'TMUX_UNAVAILABLE', cause: 'timeout' });
function fixture() {
  let now = 0, failed = false, identity = { present: true, pid: 123, created: '1' };
  let generation = '123:5';
  const scene = { sessionGroup: 'origin', runId: 'old', runtime: 'claude', present: true, ready: true,
    processRunning: true, tmuxTarget: { serverGeneration: generation, sessionId: '$1', paneId: '%1' } };
  const alerts = [], killed = [];
  const guard = new SupervisorServerHealth({ now: () => now, readProcessIdentity: () => identity,
    sendAlert: (...args) => alerts.push(args), signalProcess: pid => { killed.push(pid); identity = { present: false }; } });
  const base = { connectionOptions: {}, observe: async () => { if (failed) throw unavailable(); return [scene]; },
    observeGroup: async () => { if (failed) throw unavailable(); return scene; },
    readRun: async () => { if (failed) throw unavailable(); return scene; },
    readIdentity: async () => { if (failed) throw unavailable(); return scene; },
    bindTarget: async () => { if (failed) throw unavailable(); return {expectedRunId:scene.runId,tmuxTarget:scene.tmuxTarget}; },
    listRuns: async () => { if (failed) throw unavailable(); return [scene]; } };
  const provider = new SupervisorServerObservation(base, { guard, open: async () => ({ serverGeneration: generation, close() {} }) });
  return { provider, base, guard, scene, alerts, killed, setFailure: v => failed = v,
    setIdentity: v => identity = v, setGeneration: v => generation = v, advance: ms => now += ms };
}
test('T02 unknown socket retains occupancy but never exports cached ready identity; direct reads remain strict', async () => {
  const f = fixture(); await f.provider.observe(); f.setFailure(true);
  const [unknown] = await f.provider.observe();
  assert.equal(unknown.present, true); assert.equal(unknown.ready, false);
  assert.equal(unknown.processRunning, undefined); assert.equal(unknown.runId, null);
  for (const method of ['observeGroup', 'readRun', 'readIdentity', 'bindTarget', 'listRuns']) await assert.rejects(f.provider[method]('origin'), { code: 'TMUX_UNAVAILABLE' });
  const cold = fixture(); cold.setFailure(true);
  await assert.rejects(cold.provider.observe(), { code: 'TMUX_UNAVAILABLE' });
});
test('T02 cached original exit is reported once and does not establish replacement-group absence', async () => {
  const f = fixture(); await f.provider.observe(); f.setFailure(true);
  f.setIdentity({ present: true, pid: 123, created: 'replacement' });
  const [unknown] = await f.provider.observe(); assert.equal(unknown.present, true);
  assert.deepEqual(f.provider.takeServerExits(), [{ generation: '123:5', scenes: [f.scene] }]);
  await f.provider.observe(); assert.deepEqual(f.provider.takeServerExits(), []); assert.deepEqual(f.killed, []);
});
test('T02 deferred server maintenance does not reenter lifecycle queue or invert socket/lifecycle locks', { timeout: 1000 }, async () => {
  const f = fixture(); let owned = false;
  f.guard.lifecycleSerial = async operation => {
    assert.equal(owned, false); owned = true;
    // A lifecycle action observing the same socket while maintenance waits must finish.
    await f.provider.observe();
    try { return await operation(); } finally { owned = false; }
  };
  await f.provider.observe(); f.setFailure(true); await f.provider.observe(); f.advance(600000);
  owned = true; await f.provider.observe(); owned = false;
  assert.equal(f.killed.length, 0); assert.equal(f.alerts.length, 0);
  await f.provider.advance(); assert.deepEqual(f.killed, [123]); assert.equal(f.alerts.length, 2);
});
test('T02 a new successful observation while queued cancels old-server termination', async () => {
  const f = fixture(); await f.provider.observe(); f.setFailure(true); await f.provider.observe(); f.advance(600000);
  f.guard.lifecycleSerial = async operation => { f.setFailure(false); await f.provider.observe(); return operation(); };
  await f.provider.advance(); assert.equal(f.killed.length, 0);
});
test('T02 observed no-server is valid absence, but later unavailable cannot assume empty capacity', async () => {
  const f = fixture(); f.base.observe = async () => [];
  f.provider.open = async () => { throw Object.assign(new Error(), { code: 'TMUX_NO_SERVER' }); };
  assert.deepEqual(await f.provider.observe(), []);
  f.base.observe = async () => { throw unavailable(); };
  await assert.rejects(f.provider.observe(), { code: 'TMUX_UNAVAILABLE' });
});
test('T02 F1 alert target splits at first colon and rejects invalid/control-character destinations', () => {
  assert.deepEqual(parseServerAlertTarget('web-console:console'), { channel: 'web-console', endpoint: 'console' });
  assert.deepEqual(parseServerAlertTarget('feishu:abc|type:p2p'), { channel: 'feishu', endpoint: 'abc|type:p2p' });
  for (const value of [null, '', ':foo', 'foo:', 'foo:bar\n']) assert.equal(parseServerAlertTarget(value), null);
});
test('T02 observations spanning server generations cannot publish mixed ready scenes', async () => {
  const f = fixture(); await f.provider.observe();
  const replacement = {...f.scene,sessionGroup:'second',tmuxTarget:{...f.scene.tmuxTarget,serverGeneration:'123:6'}};
  f.base.observe = async () => [f.scene,replacement];
  f.base.listRuns = f.base.observe;
  const [unknown] = await f.provider.observe(); assert.equal(unknown.ready, false); assert.equal(unknown.runId, null);
  await assert.rejects(f.provider.listRuns(), { code: 'TMUX_UNAVAILABLE' });
});
test('T02 bound generation avoids another tmux connection and bind/list failures reach server health', async () => {
  const f = fixture();
  f.provider.open = async () => { throw Error('identity was already observed'); };
  await f.provider.observe(); await f.provider.observeGroup('origin'); await f.provider.readIdentity('origin');
  assert.equal(f.guard.servers.get('default').cache.generation, '123:5');
  f.setFailure(true);
  await assert.rejects(f.provider.bindTarget(f.scene), {code:'TMUX_UNAVAILABLE'});
  assert.ok(f.guard.servers.get('default').episode);
  f.setFailure(false); await f.provider.observe();
  f.base.listRuns = async () => [await f.base.observeGroup('origin')]; f.setFailure(true);
  await assert.rejects(f.provider.listRuns(), {code:'TMUX_UNAVAILABLE'});
  assert.ok(f.guard.servers.get('default').episode);
  f.setFailure(false); await f.provider.observe();
  f.base.listRuns = async () => [{...f.scene,observationError:unavailable()}];
  await assert.rejects(f.provider.listRuns(), {code:'TMUX_UNAVAILABLE'});
  assert.ok(f.guard.servers.get('default').episode);
});
test('T02 readable tmux identity remains usable when OS identity cannot be cached for termination', async () => {
  const f = fixture(); f.setIdentity({ present: null });
  const [scene] = await f.provider.observe(); assert.equal(scene.ready, true);
  assert.equal(f.guard.servers.get('default').cache, null);
});
