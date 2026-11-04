import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModeSwitchCoordinator } from '../mode-switch.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { RestartRequestStore, validateRestartRequests } from '../restart-request-store.js';

const restart = id => ({ version: 1, type: 'restart_all', requestId: id, reason: 'upgrade' });
const manual = (overrides = {}) => ({ version: 1, type: 'manual_restart', requestId: 'manual', expectedRunId: 'r1', ...overrides });
const config = (overrides = {}) => ({ version: 1, type: 'ready_for_config_reclaim', requestId: 'config', expectedRunId: 'r1', sessionGroup: 'telegram:a', ...overrides });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'restart-requests.json'), store = new RestartRequestStore({ file });
  const state = { mode: 'multi', transition: null, fences: new Map(), runs: [{runId:'r1'}, {runId:'r2'}, {runId:'starting'}],
    run: {runId:'r1', ready:true, launchConfig:{runtime:'claude',mode:'default'}}, expected:{runtime:'codex',mode:'default'}, events:[] };
  const db = { getModeTransition: () => state.transition, getDrainFence: g => state.fences.get(g) ?? null,
    setDrainFence: (g,f) => { if (!state.fences.has(g)) state.fences.set(g,f); } };
  const deps = { store, db, readMode: () => ({mode:state.mode}), listRuns: () => state.runs, readRun: () => state.run,
    resolveLaunchConfig: () => state.expected, preflightReclaim: async () => {}, now: () => 1792000000123, diagnostic: event => state.events.push(event) };
  const admission = new SupervisorAdmission(deps); admission.openEntry();
  return { root, file, store, state, db, admission, deps };
}
test('restart persists exact snapshot before reply and survives owner reconstruction', async t => {
  const f = fixture(t); const response = await f.admission.handle(restart('upgrade'));
  assert.equal(response.result, 'accepted'); assert.equal(response.runCount, 3);
  assert.deepEqual(f.store.read()[0].runIds, ['r1','r2','starting']);
  const next = new SupervisorAdmission(f.deps); assert.equal((await next.handle(restart('upgrade'))).code, 'entry_not_open');
  assert.equal(next.restore().requests.length, 1); next.openEntry(); f.state.runs.push({runId:'new'});
  assert.equal((await next.handle(restart('upgrade'))).result, 'already_accepted'); assert.equal(f.store.read()[0].runIds.length, 3);
  assert.equal((await next.handle(manual({requestId:'upgrade'}))).reason, 'request_conflict');
});
test('restart empty writes only completion and steady single refuses', async t => {
  const f = fixture(t); f.state.runs = [];
  assert.equal((await f.admission.handle(restart('empty'))).result, 'done_empty'); assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.state.events, [{event:'restart_done', requestId:'empty'}]);
  f.state.mode = 'single'; assert.equal((await f.admission.handle(restart('single'))).code, 'single_mode');
  f.state.transition = {phase:'gating'}; f.state.runs = [{runId:'legacy'}];
  assert.equal((await f.admission.handle(restart('during-transition'))).result, 'accepted');
});
test('invalid refuses admission without changing any byte', async t => {
  const f = fixture(t);
  const modeSwitch = new ModeSwitchCoordinator({ db:f.db, readRequests:()=>f.store.read(), readMode:()=>({mode:'single'}), legacyPresent:()=>false });
  f.admission.modeSwitch = (...args) => modeSwitch.handle(...args);
  const good = {requestId:'x', reason:'upgrade', acceptedAt:1792000000000, runIds:['r1']};
  for (const content of ['{', '{}', JSON.stringify([{...good, extra:true}]), JSON.stringify([good,good]), JSON.stringify([{...good,runIds:[]}]), JSON.stringify([{...good,acceptedAt:null}])]) {
    fs.writeFileSync(f.file, content);
    assert.equal((await f.admission.handle(restart('new'))).code, 'requests_unreadable');
    assert.equal((await f.admission.handle(manual())).reason, 'requests_unreadable');
    assert.equal((await f.admission.handle({version:1,type:'mode_switch',requestId:'switch',target:'multi'})).code, 'requests_unreadable');
    assert.equal(fs.readFileSync(f.file,'utf8'), content);
  }
  assert.equal(validateRestartRequests([good]), true);
});
test('unknown live identity and write failures never return false accepted', async t => {
  const f = fixture(t); f.state.runs = [{runId:'r1'}, {runId:null}];
  await assert.rejects(f.admission.handle(restart('unknown')), {code:'IDENTITY_UNAVAILABLE'}); assert.deepEqual(f.store.read(), []);
  f.state.runs = [{runId:'r1'}]; f.store.publish = () => {throw Object.assign(new Error('disk'),{code:'EIO'});};
  await assert.rejects(f.admission.handle(restart('disk')), {code:'EIO'}); assert.deepEqual(f.store.read(), []);
});
test('manual idempotence precedes all conflicts and stores the run identity', async t => {
  const f = fixture(t); assert.equal((await f.admission.handle(manual())).result, 'accepted');
  const row = f.store.read()[0]; assert.equal(row.expectedRunId,'r1'); assert.equal(Object.hasOwn(row,'tmuxTarget'),false); assert.equal(row.mode,'multi');
  f.state.transition = {phase:'gating'}; f.state.fences.set('*',{reason:'transition'});
  assert.equal((await f.admission.handle(manual())).result,'already_accepted');
  assert.equal((await f.admission.handle(manual({expectedRunId:'new'}))).reason,'request_conflict');
  assert.equal((await f.admission.handle(restart('upgrade'))).code,'manual_restart_pending');
});
test('conflicts precede absent-target result in frozen order', async t => {
  const f = fixture(t); f.state.run = null;
  f.state.transition = {}; assert.equal((await f.admission.handle(manual())).reason,'transition_open'); f.state.transition = null;
  await f.admission.handle(restart('upgrade')); assert.equal((await f.admission.handle(manual())).reason,'restart_all_pending'); f.store.write([]);
  for (const g of ['origin','*']) { f.state.fences.set(g,{reason:'ttl'}); assert.equal((await f.admission.handle(manual())).reason,'fence_conflict'); f.state.fences.clear(); }
  assert.equal((await f.admission.handle(manual())).result,'already_stopped'); assert.equal((await f.admission.handle(manual({expectedRunId:undefined}))).code,'invalid_request');
  const noTarget=manual(); delete noTarget.expectedRunId;
  assert.equal((await f.admission.handle(noTarget)).result,'already_stopped');
  f.state.run={}; assert.equal((await f.admission.handle(noTarget)).reason,'target_required');
});
test('stale, incomplete and starting identity cannot become manual targets', async t => {
  const f = fixture(t); f.state.run.runId='new';
  const stale=await f.admission.handle(manual()); assert.equal(stale.result,'stale_target'); assert.equal(stale.currentRunId,'new');
  f.state.run.runId=null; assert.equal((await f.admission.handle(manual())).reason,'identity_unavailable');
  f.state.run.runId='r1'; f.state.run.ready=false; assert.equal((await f.admission.handle(manual())).reason,'not_ready');
  assert.deepEqual(f.store.read(),[]);
});
test('config rechecks complete snapshot and current input; same run fence is idempotent', async t => {
  const f=fixture(t); f.state.run.launchConfig={runtime:'claude',mode:'override',model:'a'};
  assert.equal((await f.admission.handle(config())).reason,'snapshot_unavailable');
  f.state.run.launchConfig={runtime:'claude',mode:'default'}; f.state.expected={runtime:'claude',mode:'default'};
  assert.equal((await f.admission.handle(config())).result,'unchanged'); assert.equal(f.state.fences.size,0);
  f.state.expected={runtime:'claude',mode:'override',model:'a',effort:'high'};
  assert.equal((await f.admission.handle(config())).result,'accepted'); assert.deepEqual(f.state.fences.get('telegram:a'),{reason:'model_config',runId:'r1'});
  f.state.expected=f.state.run.launchConfig; assert.equal((await f.admission.handle(config())).result,'already_accepted');
  f.state.run.runId='new'; assert.equal((await f.admission.handle(config())).reason,'run_changed');
});
test('config reclaim tolerates unreadable restart requests for ordinary groups and fails closed for origin', async t => {
  const f=fixture(t); let reads=0, preflights=0;
  const read=f.store.read.bind(f.store); f.store.read=()=>{reads++;return read();};
  f.admission.preflightReclaim=async()=>{preflights++;};
  fs.writeFileSync(f.file,'{unreadable-original');
  assert.equal((await f.admission.handle(config())).result,'accepted');
  assert.equal(reads,1); assert.equal(preflights,1);
  assert.equal(fs.readFileSync(f.file,'utf8'),'{unreadable-original');
  f.state.fences.clear();
  const origin=config({sessionGroup:'origin'});
  assert.deepEqual(await f.admission.handle(origin),{version:1,type:'ready_for_config_reclaim',requestId:'config',ok:false,result:'rejected',reason:'requests_unreadable'});
  assert.equal(reads,2); assert.equal(preflights,1); assert.equal(f.state.fences.size,0);
  assert.equal(fs.readFileSync(f.file,'utf8'),'{unreadable-original');
  f.store.write([]);
  assert.equal((await f.admission.handle(origin)).result,'accepted');
  assert.equal(reads,3); assert.equal(preflights,2);
  assert.deepEqual(f.state.fences.get('origin'),{reason:'model_config',runId:'r1'});
  f.state.fences.clear(); f.admission.preflightReclaim=async()=>{throw Object.assign(new Error('unrelated dependency'),{code:'requests_unreadable'});};
  await assert.rejects(f.admission.handle(config()),{code:'requests_unreadable'});
});
test('config conflicts hold and DB failure does not acknowledge', async t => {
  const f=fixture(t); f.state.mode='single'; assert.equal((await f.admission.handle(config())).reason,'not_multi'); f.state.mode='multi';
  f.state.fences.set('*',{reason:'mode_switch'}); assert.equal((await f.admission.handle(config())).reason,'transition_open'); f.state.fences.clear();
  f.state.fences.set('telegram:a',{reason:'ttl',runId:'r1'}); assert.equal((await f.admission.handle(config())).reason,'other_fence'); f.state.fences.clear();
  await f.admission.handle(manual()); assert.equal((await f.admission.handle(config({sessionGroup:'origin'}))).reason,'manual_restart_pending');
  f.db.setDrainFence=()=>{throw Object.assign(new Error('busy'),{code:'DB_BUSY'});};
  await assert.rejects(f.admission.handle(config()),{code:'DB_BUSY'});
});
test('shared lifecycle queue serializes snapshots without nesting runtime writes', async t => {
  const f=fixture(t); const order=[]; let release;
  const lock=f.admission.serialize(async()=>{order.push('lifecycle'); await new Promise(r=>release=r);});
  const queued=f.admission.handle(restart('queued')).then(()=>order.push('admitted'));
  await new Promise(r=>setImmediate(r)); assert.deepEqual(order,['lifecycle']);
  f.admission.startAttempt=async req=>({...req,ok:true,result:'not_restricted'});
  assert.equal((await f.admission.handle({version:1,type:'start_attempt',requestId:'start'})).result,'not_restricted');
  release(); await Promise.all([lock,queued]); assert.deepEqual(order,['lifecycle','admitted']);
});

test('startup gate rejects four new request families and keeps start_attempt unclassified until ready', async t => {
  const f=fixture(t);f.admission.closeEntry();
  for(const request of [restart('a'),manual(),config(),{version:1,type:'mode_switch',requestId:'m',target:'single'}]) {
    assert.equal((await f.admission.handle(request)).code,'entry_not_open');
  }
  await assert.rejects(f.admission.handle({version:1,type:'start_attempt',requestId:'start'}),{code:'START_ADMISSION_CLOSED'});
  assert.deepEqual(f.store.read(),[]);
});

// : only the complete runtime-specific shape can authorize a fence.
test('config admission refuses malformed snapshots and fails closed on invalid expected config', async t => {
  const f = fixture(t);
  const invalid = [[], { runtime:'unknown', mode:'default' }, { runtime:'claude', mode:'default', extra:true },
    ...['', ' ', 'x\0y'].map(model => ({runtime:'claude',mode:'override',model,effort:'high'})),
    ...['', ' ', 'xhigh', 'high\0'].map(effort => ({runtime:'claude',mode:'override',model:'x',effort})),
    {runtime:'codex',mode:'override',model:'x',effort:'max'}];
  for (const snapshot of invalid) {
    f.state.run.launchConfig = snapshot;
    assert.equal((await f.admission.handle(config())).reason, 'snapshot_unavailable');
    assert.equal(f.state.fences.size, 0);
  }
  f.state.run.launchConfig = {runtime:'claude',mode:'default'};
  for (const expected of invalid) {
    f.state.expected = expected;
    await assert.rejects(f.admission.handle(config()), {code:'CONFIG_UNREADABLE'});
    assert.equal(f.state.fences.size, 0);
  }
  f.state.expected = {runtime:'codex',mode:'override',model:'x',effort:'xhigh'};
  assert.equal((await f.admission.handle(config())).result, 'accepted');
});

test('config reclaim missing or failed dependency cannot fence a receiving group', async t => {
 const f=fixture(t);
 for (const preflight of [undefined, async()=>{throw Object.assign(new Error('Sync unavailable'),{code:'DEPENDENCY_UNAVAILABLE'});}]) {
  f.admission.preflightReclaim=preflight;
  await assert.rejects(f.admission.handle(config()),{code:'DEPENDENCY_UNAVAILABLE'});
  assert.equal(f.state.fences.size,0);
 }
 let calls=0;
 f.admission.preflightReclaim=async(scene,context)=>{calls++;assert.equal(scene.sessionGroup,'telegram:a');assert.equal(scene.runId,'r1');assert.equal(context.configuration.mode,'multi');assert.equal(f.state.fences.size,0);};
 assert.equal((await f.admission.handle(config())).result,'accepted');assert.equal(calls,1);
});

// Session identity is an admission check; the durable execution target is the run.
test('manual admission checks optional sessionId once without requiring a tmux descriptor', async t => {
  const f = fixture(t); f.state.run.sessionId='session-1';
  assert.equal((await f.admission.handle(manual({expectedSessionId:'old-session'}))).reason,'identity_unavailable');
  assert.deepEqual(f.store.read(),[]);
  assert.equal((await f.admission.handle(manual({expectedSessionId:'session-1'}))).result,'accepted');
  const [row] = f.store.read();
  assert.deepEqual(row,{requestId:'manual',reason:'manual_restart',acceptedAt:1792000000123,runIds:['r1'],
    mode:'multi',expectedRunId:'r1'});
  f.state.run.sessionId='session-2';
  assert.equal((await f.admission.handle(manual({expectedSessionId:'session-1'}))).result,'already_accepted');
  assert.equal((await f.admission.handle(manual({expectedSessionId:'session-2'}))).result,'already_accepted');
  assert.equal(validateRestartRequests([{...row,expectedSessionId:'session-1'}]),false);
  assert.equal(validateRestartRequests([{...row,tmuxTarget:{serverGeneration:'123:4',sessionId:'$1',paneId:'%1'}}]),false);
});


test('manual admission targets only the requested group and keeps one instance-wide request', async t => {
  const f = fixture(t), observed = [];
  f.admission.readRun = group => { observed.push(group); return f.state.run; };
  f.state.fences.set('origin', { reason: 'ttl', runId: 'origin-run' });
  const request = manual({ sessionGroup: 'telegram:a' });
  assert.equal((await f.admission.handle(request)).result, 'accepted');
  assert.deepEqual(observed, ['telegram:a']);
  assert.deepEqual(f.store.read(), [{ requestId: 'manual', reason: 'manual_restart', acceptedAt: 1792000000123,
    runIds: ['r1'], mode: 'multi', expectedRunId: 'r1', sessionGroup: 'telegram:a' }]);
  assert.equal((await f.admission.handle(manual({ requestId: 'another', sessionGroup: 'telegram:b' }))).reason, 'manual_restart_pending');
  assert.equal((await f.admission.handle(manual({ sessionGroup: 'telegram:b' }))).reason, 'request_conflict');
  assert.equal((await f.admission.handle(request)).result, 'already_accepted');
});

test('explicit manual group reports stale, absent and fenced targets without changing intent', async t => {
  const f = fixture(t), request = manual({ sessionGroup: 'telegram:a' });
  f.state.run.runId = 'replacement';
  assert.deepEqual(await f.admission.handle(request), { version: 1, type: 'manual_restart', requestId: 'manual',
    ok: false, result: 'stale_target', currentRunId: 'replacement' });
  f.state.run = null;
  assert.equal((await f.admission.handle(request)).result, 'already_stopped');
  assert.deepEqual(f.store.read(), []); assert.equal(f.state.fences.size, 0);
  f.state.fences.set('telegram:a', { reason: 'ttl', runId: 'r1' });
  assert.equal((await f.admission.handle(request)).reason, 'fence_conflict');
  assert.deepEqual(f.store.read(), []);
});

test('manual group validation distinguishes single mode from invalid group syntax', async t => {
  const f = fixture(t); f.state.mode = 'single';
  assert.equal((await f.admission.handle(manual({ sessionGroup: 'telegram:a' }))).reason, 'not_multi');
  for (const sessionGroup of ['bad key', '', '*', null, undefined]) {
    assert.equal((await f.admission.handle(manual({ sessionGroup }))).code, 'invalid_request');
  }
  assert.deepEqual(f.store.read(), []);
});

// Frozen pre-change manual implementation is a compatibility fixture. It is
// statically defined, never read or reevaluated from product source at runtime.
async function legacyManual(request, rows) {
  const nonempty = value => typeof value === 'string' && value.length > 0;
  const rejected = reason => ({ ok: false, result: 'rejected', reason });
  const existing = rows.find(row => row.requestId === request.requestId);
  if (existing) return existing.reason === 'manual_restart' && existing.expectedRunId === request.expectedRunId
    ? { ok: true, result: 'already_accepted' } : rejected('request_conflict');
  if (await this.db.getModeTransition()) return rejected('transition_open');
  if (rows.some(row => row.reason === 'upgrade')) return rejected('restart_all_pending');
  if (await this.db.getDrainFence('origin') || await this.db.getDrainFence('*')) return rejected('fence_conflict');
  if (rows.some(row => row.reason === 'manual_restart')) return rejected('manual_restart_pending');
  const mode = (await this.readMode()).mode ?? 'single';
  const run = await this.readRun(mode === 'multi' ? 'origin' : null);
  if (!request.expectedRunId) return run === null ? { ok: true, result: 'already_stopped' } : rejected('target_required');
  if (run === null) return { ok: true, result: 'already_stopped' };
  if (nonempty(run?.runId) && run.runId !== request.expectedRunId) return { ok: false, result: 'stale_target', currentRunId: run.runId };
  if (!nonempty(run?.runId)) return rejected('identity_unavailable');
  if (!run.ready) return rejected('not_ready');
  if (request.expectedSessionId !== undefined && request.expectedSessionId !== run.sessionId) return rejected('identity_unavailable');
  const row = { requestId: request.requestId, reason: 'manual_restart', acceptedAt: this.now(), runIds: [run.runId], mode, expectedRunId: run.runId };
  this.store.write([...rows, row]);
  return { ok: true, result: 'accepted' };
}

test('manual rows accept an optional multi group while retaining old field and byte shape', async t => {
  for (const mode of ['single', 'multi']) {
    const f = fixture(t), previous = fixture(t);
    f.state.mode = previous.state.mode = mode;
    previous.admission.manual = legacyManual;
    const request = manual({ requestId: mode });
    assert.deepEqual(await f.admission.handle(request), await previous.admission.handle(request));
    const [row] = f.store.read();
    assert.deepEqual(f.store.read(), previous.store.read());
    assert.equal(fs.readFileSync(f.file, 'utf8'), fs.readFileSync(previous.file, 'utf8'));
    assert.equal(Object.hasOwn(row, 'sessionGroup'), false);
    assert.equal(validateRestartRequests([{ ...row, sessionGroup: 'telegram:a' }]), mode === 'multi');
    assert.equal(validateRestartRequests([{ ...row, sessionGroup: 'bad key' }]), false);
  }
});

test('manual intent and configuration reclaim exclude only their common target group', async t => {
  const f = fixture(t);
  const group = 'telegram:a';
  assert.equal((await f.admission.handle(manual({ sessionGroup: group }))).result, 'accepted');
  assert.equal((await f.admission.handle(config({ sessionGroup: group }))).reason, 'manual_restart_pending');
  assert.equal(f.state.fences.has(group), false);
  assert.equal((await f.admission.handle(config({ sessionGroup: 'origin' }))).result, 'accepted');
  assert.equal((await f.admission.handle(config({ sessionGroup: 'telegram:b' }))).result, 'accepted');
  f.store.write([]); f.state.fences.clear();
  assert.equal((await f.admission.handle(manual())).result, 'accepted');
  assert.equal((await f.admission.handle(config({ sessionGroup: 'origin' }))).reason, 'manual_restart_pending');
  assert.equal((await f.admission.handle(config({ sessionGroup: group }))).result, 'accepted');
  f.store.write([]);
  assert.equal((await f.admission.handle(manual({ sessionGroup: group }))).reason, 'fence_conflict');
});
