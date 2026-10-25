import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { RestartRequestStore, validateRestartRequests } from '../restart-request-store.js';

const target = { serverGeneration: '123:1792000000', sessionId: '$3', paneId: '%7' };
const restart = id => ({ version: 1, type: 'restart_all', requestId: id, reason: 'upgrade' });
const manual = (overrides = {}) => ({ version: 1, type: 'manual_restart', requestId: 'manual', expectedRunId: 'r1', ...overrides });
const config = (overrides = {}) => ({ version: 1, type: 'ready_for_config_reclaim', requestId: 'config', expectedRunId: 'r1', sessionGroup: 'telegram:a', ...overrides });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'restart-requests.json'), store = new RestartRequestStore({ file });
  const state = { mode: 'multi', transition: null, fences: new Map(), runs: [{runId:'r1'}, {runId:'r2'}, {runId:'starting'}],
    run: {runId:'r1', ready:true, tmuxTarget:target, launchConfig:{runtime:'claude',mode:'default'}}, expected:{runtime:'codex',mode:'default'}, events:[] };
  const db = { getModeTransition: () => state.transition, getDrainFence: g => state.fences.get(g) ?? null,
    setDrainFence: (g,f) => { if (!state.fences.has(g)) state.fences.set(g,f); } };
  const deps = { store, db, readMode: () => ({mode:state.mode}), listRuns: () => state.runs, readRun: () => state.run,
    resolveLaunchConfig: () => state.expected, now: () => 1792000000123, diagnostic: event => state.events.push(event) };
  const admission = new SupervisorAdmission(deps); admission.openEntry();
  return { root, file, store, state, db, admission, deps };
}
test('IF-34/DM-42 restart persists exact snapshot before reply and survives owner reconstruction', async t => {
  const f = fixture(t); const response = await f.admission.handle(restart('upgrade'));
  assert.equal(response.result, 'accepted'); assert.equal(response.runCount, 3);
  assert.deepEqual(f.store.read()[0].runIds, ['r1','r2','starting']);
  const next = new SupervisorAdmission(f.deps); assert.equal((await next.handle(restart('upgrade'))).code, 'entry_not_open');
  assert.equal(next.restore().requests.length, 1); next.openEntry(); f.state.runs.push({runId:'new'});
  assert.equal((await next.handle(restart('upgrade'))).result, 'already_accepted'); assert.equal(f.store.read()[0].runIds.length, 3);
  assert.equal((await next.handle(manual({requestId:'upgrade'}))).reason, 'request_conflict');
});
test('IF-34 restart empty writes only completion and steady single refuses', async t => {
  const f = fixture(t); f.state.runs = [];
  assert.equal((await f.admission.handle(restart('empty'))).result, 'done_empty'); assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.state.events, [{event:'restart_done', requestId:'empty'}]);
  f.state.mode = 'single'; assert.equal((await f.admission.handle(restart('single'))).code, 'single_mode');
  f.state.transition = {phase:'gating'}; f.state.runs = [{runId:'legacy'}];
  assert.equal((await f.admission.handle(restart('during-transition'))).result, 'accepted');
});
test('DM-54 invalid F9 refuses admission without changing any byte', async t => {
  const f = fixture(t);
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
test('IF-34 unknown live identity and write failures never return false accepted', async t => {
  const f = fixture(t); f.state.runs = [{runId:'r1'}, {runId:null}];
  await assert.rejects(f.admission.handle(restart('unknown')), {code:'IDENTITY_UNAVAILABLE'}); assert.deepEqual(f.store.read(), []);
  f.state.runs = [{runId:'r1'}]; f.store.publish = () => {throw Object.assign(new Error('disk'),{code:'EIO'});};
  await assert.rejects(f.admission.handle(restart('disk')), {code:'EIO'}); assert.deepEqual(f.store.read(), []);
});
test('IF-36 manual idempotence precedes all conflicts and stores fixed identity', async t => {
  const f = fixture(t); assert.equal((await f.admission.handle(manual())).result, 'accepted');
  const row = f.store.read()[0]; assert.deepEqual(row.tmuxTarget, target); assert.equal(row.mode,'multi');
  f.state.transition = {phase:'gating'}; f.state.fences.set('*',{reason:'transition'});
  assert.equal((await f.admission.handle(manual())).result,'already_accepted');
  assert.equal((await f.admission.handle(manual({expectedRunId:'new'}))).reason,'request_conflict');
  assert.equal((await f.admission.handle(restart('upgrade'))).code,'manual_restart_pending');
});
test('IF-36 conflicts precede absent-target result in frozen order', async t => {
  const f = fixture(t); f.state.run = null;
  f.state.transition = {}; assert.equal((await f.admission.handle(manual())).reason,'transition_open'); f.state.transition = null;
  await f.admission.handle(restart('upgrade')); assert.equal((await f.admission.handle(manual())).reason,'restart_all_pending'); f.store.write([]);
  for (const g of ['origin','*']) { f.state.fences.set(g,{reason:'ttl'}); assert.equal((await f.admission.handle(manual())).reason,'fence_conflict'); f.state.fences.clear(); }
  assert.equal((await f.admission.handle(manual())).result,'already_stopped'); assert.equal((await f.admission.handle(manual({expectedRunId:undefined}))).code,'invalid_request');
  const noTarget=manual(); delete noTarget.expectedRunId;
  assert.equal((await f.admission.handle(noTarget)).result,'already_stopped');
  f.state.run={}; assert.equal((await f.admission.handle(noTarget)).reason,'target_required');
});
test('IF-36 stale, incomplete and starting identity cannot become manual targets', async t => {
  const f = fixture(t); f.state.run.runId='new';
  const stale=await f.admission.handle(manual()); assert.equal(stale.result,'stale_target'); assert.equal(stale.currentRunId,'new');
  f.state.run.runId=null; assert.equal((await f.admission.handle(manual())).reason,'identity_unavailable');
  f.state.run.runId='r1'; f.state.run.tmuxTarget={sessionId:'$1',paneId:'%1'}; assert.equal((await f.admission.handle(manual())).reason,'identity_unavailable');
  f.state.run.tmuxTarget=target; f.state.run.ready=false; assert.equal((await f.admission.handle(manual())).reason,'not_ready');
  assert.deepEqual(f.store.read(),[]);
});
test('IF-35 config rechecks complete snapshot and current input; same run fence is idempotent', async t => {
  const f=fixture(t); f.state.run.launchConfig={runtime:'claude',mode:'override',model:'a'};
  assert.equal((await f.admission.handle(config())).reason,'snapshot_unavailable');
  f.state.run.launchConfig={runtime:'claude',mode:'default'}; f.state.expected={runtime:'claude',mode:'default'};
  assert.equal((await f.admission.handle(config())).result,'unchanged'); assert.equal(f.state.fences.size,0);
  f.state.expected={runtime:'claude',mode:'override',model:'a',effort:'high'};
  assert.equal((await f.admission.handle(config())).result,'accepted'); assert.deepEqual(f.state.fences.get('telegram:a'),{reason:'model_config',runId:'r1'});
  f.state.expected=f.state.run.launchConfig; assert.equal((await f.admission.handle(config())).result,'already_accepted');
  f.state.run.runId='new'; assert.equal((await f.admission.handle(config())).reason,'run_changed');
});
test('IF-35 config conflicts hold and DB failure does not acknowledge', async t => {
  const f=fixture(t); f.state.mode='single'; assert.equal((await f.admission.handle(config())).reason,'not_multi'); f.state.mode='multi';
  f.state.fences.set('*',{reason:'mode_switch'}); assert.equal((await f.admission.handle(config())).reason,'transition_open'); f.state.fences.clear();
  f.state.fences.set('telegram:a',{reason:'ttl',runId:'r1'}); assert.equal((await f.admission.handle(config())).reason,'other_fence'); f.state.fences.clear();
  await f.admission.handle(manual()); assert.equal((await f.admission.handle(config({sessionGroup:'origin'}))).reason,'manual_restart_pending');
  f.db.setDrainFence=()=>{throw Object.assign(new Error('busy'),{code:'DB_BUSY'});};
  await assert.rejects(f.admission.handle(config()),{code:'DB_BUSY'});
});
test('T04 shared lifecycle queue serializes snapshots without nesting runtime writes', async t => {
  const f=fixture(t); const order=[]; let release;
  const lock=f.admission.serialize(async()=>{order.push('lifecycle'); await new Promise(r=>release=r);});
  const queued=f.admission.handle(restart('queued')).then(()=>order.push('admitted'));
  await new Promise(r=>setImmediate(r)); assert.deepEqual(order,['lifecycle']);
  f.admission.startAttempt=async req=>({...req,ok:true,result:'not_restricted'});
  assert.equal((await f.admission.handle({version:1,type:'start_attempt',requestId:'start'})).result,'not_restricted');
  release(); await Promise.all([lock,queued]); assert.deepEqual(order,['lifecycle','admitted']);
});

test('T04 startup gate rejects four new request families and keeps start_attempt unclassified until ready', async t => {
  const f=fixture(t);f.admission.closeEntry();
  for(const request of [restart('a'),manual(),config(),{version:1,type:'mode_switch',requestId:'m',target:'single'}]) {
    assert.equal((await f.admission.handle(request)).code,'entry_not_open');
  }
  await assert.rejects(f.admission.handle({version:1,type:'start_attempt',requestId:'start'}),{code:'START_ADMISSION_CLOSED'});
  assert.deepEqual(f.store.read(),[]);
});

// IF-35 / F2: only the complete runtime-specific shape can authorize a fence.
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
