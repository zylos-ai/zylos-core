import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorServerHealth } from '../supervisor-server-health.js';
import { SupervisorServerObservation, parseServerAlertTarget } from '../supervisor-server-observation.js';
const unavailable = () => Object.assign(new Error('timeout'), { code: 'TMUX_UNAVAILABLE', cause: 'timeout' });
function fixture() {
  let now = 0, failed = false;
  const scene = { sessionGroup: 'origin', runId: 'old', runtime: 'claude', present: true, ready: true,
    processRunning: true, tmuxTarget: { serverGeneration: '123:5', sessionId: '$1', paneId: '%1' } };
  const alerts = [];
  const guard = new SupervisorServerHealth({ now: () => now, sendAlert: (...args) => alerts.push(args) });
  const base = { observe: async () => { if (failed) throw unavailable(); return [scene]; },
    observeGroup: async () => { if (failed) throw unavailable(); return scene; },
    readRun: async () => { if (failed) throw unavailable(); return scene; },
    readIdentity: async () => { if (failed) throw unavailable(); return scene; },
    bindTarget: async () => { if (failed) throw unavailable(); return {expectedRunId:scene.runId,tmuxTarget:scene.tmuxTarget}; },
    listRuns: async () => { if (failed) throw unavailable(); return [scene]; } };
  const provider = new SupervisorServerObservation(base, { guard });
  return { provider, base, guard, scene, alerts, setFailure: v => failed = v, advance: ms => now += ms };
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
test('T02 unavailable occupancy remains unknown after ten minutes without synthetic exits', async () => {
  const f = fixture(); await f.provider.observe(); f.setFailure(true);
  await f.provider.observe(); f.advance(600000);
  const [unknown] = await f.provider.observe();
  assert.equal(unknown.present,true); assert.equal(unknown.ready,false);
  assert.deepEqual(await f.provider.advance(),{status:'unavailable'});
  assert.equal(f.alerts.length,1);
});
test('T02 observed no-server follows absence and clears cached occupancy and alerts', async () => {
  const f = fixture(); await f.provider.observe(); f.setFailure(true); await f.provider.observe();
  f.base.observe = async () => { throw Object.assign(new Error(),{code:'TMUX_NO_SERVER'}); };
  await assert.rejects(f.provider.observe(),{code:'TMUX_NO_SERVER'});
  f.advance(60000); assert.deepEqual(await f.provider.advance(),{status:'observable'});
  assert.equal(f.alerts.length,0);
  f.base.observe = async () => []; assert.deepEqual(await f.provider.observe(),[]);
  f.base.observe = async () => { throw unavailable(); };
  await assert.rejects(f.provider.observe(),{code:'TMUX_UNAVAILABLE'});
});
test('T02 F1 alert target splits at first colon and rejects invalid/control-character destinations', () => {
  assert.deepEqual(parseServerAlertTarget('web-console:console'), { channel: 'web-console', endpoint: 'console' });
  assert.deepEqual(parseServerAlertTarget('feishu:abc|type:p2p'), { channel: 'feishu', endpoint: 'abc|type:p2p' });
  for (const value of [null, '', ':foo', 'foo:', 'foo:bar\n']) assert.equal(parseServerAlertTarget(value), null);
});
test('T02 scene observations add no server probes and forwarded failures reach alert timing', async () => {
  const f = fixture();
  Object.defineProperty(f.base,'connectionOptions',{get(){throw Error('unexpected server probe');}});
  let observations = 0;
  for (const scene of [f.scene, {...f.scene,tmuxTarget:null}]) {
    f.base.observe = async () => { observations++; return [scene]; };
    assert.deepEqual(await f.provider.observe(),[scene]);
  }
  assert.equal(observations,2);
  await f.provider.observeGroup('origin'); await f.provider.readIdentity('origin');
  f.setFailure(true);
  await assert.rejects(f.provider.bindTarget(f.scene),{code:'TMUX_UNAVAILABLE'});
  f.advance(60000); await f.provider.advance(); assert.equal(f.alerts.length,1);
  f.setFailure(false); await f.provider.observe();
  assert.deepEqual(await f.provider.advance(),{status:'observable'});
  f.base.listRuns = async () => [{...f.scene,observationError:unavailable()}];
  await assert.rejects(f.provider.listRuns(),{code:'TMUX_UNAVAILABLE'});
});
test('T02 a non-tmux group error preserves all occupancy and does not start a server outage', async () => {
  const f = fixture();
  const failedGroup = { sessionGroup: 'broken', present: true, ready: false, tmuxTarget: null,
    observationError: Object.assign(new Error('activity read failed'), {code:'EACCES'}) };
  f.base.observe = async () => [f.scene, failedGroup];
  assert.deepEqual(await f.provider.observe(), [f.scene, failedGroup]);
  f.advance(61000);
  assert.deepEqual(await f.provider.observe(), [f.scene, failedGroup]);
  await f.provider.advance();
  assert.deepEqual(f.alerts, []);
  assert.equal(f.guard.episodes.has('default'), false);
  // A later socket failure still retains the group whose listing proved presence.
  f.base.observe = async () => { throw unavailable(); };
  assert.deepEqual((await f.provider.observe()).map(scene => scene.sessionGroup), ['origin', 'broken']);
});
test('T02 unknown occupancy has one shape after full observation or identity reads', async () => {
  const snapshots = [];
  for (const identityLast of [false, true]) {
    const f = fixture();
    Object.assign(f.scene, {tmuxName:'origin',runDir:'/fixture/origin',createdAt:123,currentSessionTs:456,
      healthIdentity:{session_id:'old',claude_pid:321},proc:{pid:321,alive:true},runtimePid:321,
      launchConfig:{model:'old'},tools:['old'],lastActivityAt:500});
    f.base.readIdentity = async () => ({sessionGroup:'origin',present:true,tmuxName:'origin',
      ready:true,runId:'old',runtime:'claude',tmuxTarget:f.scene.tmuxTarget});
    if (!identityLast) await f.provider.readIdentity('origin');
    await f.provider.observe();
    if (identityLast) await f.provider.readIdentity('origin');
    f.setFailure(true);
    const [unknown] = await f.provider.observe();
    assert.deepEqual(Object.keys(unknown).sort(), ['sessionGroup','present','tmuxName','runDir','createdAt',
      'currentSessionTs','ready','processRunning','runId','sessionId','runtime','tmuxTarget','state',
      'idleSince','usagePercent','observationError'].sort());
    const {observationError, ...occupancy} = unknown;
    assert.equal(observationError.code,'TMUX_UNAVAILABLE');
    snapshots.push(occupancy);
  }
  assert.deepEqual(snapshots[0],snapshots[1]);
});
test('T02 identity-only observation does not manufacture a full occupancy snapshot', async () => {
  const f = fixture();
  await f.provider.readIdentity('origin');
  f.setFailure(true);
  await assert.rejects(f.provider.observe(), {code:'TMUX_UNAVAILABLE'});
});
