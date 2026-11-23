import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { RestartRequestStore } from '../restart-request-store.js';

const restart = id => ({ version: 1, type: 'restart_all', requestId: id, reason: 'upgrade' });
const manual = (overrides = {}) => ({ version: 1, type: 'manual_restart', requestId: 'manual', expectedRunId: 'r1', ...overrides });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'restart-requests.json'), store = new RestartRequestStore({ file });
  const state = { mode: 'multi', transition: null, fences: new Map(), runs: [{runId:'r1'}, {runId:'r2'}, {runId:'starting'}],
    run: {runId:'r1', ready:true, launchConfig:{runtime:'claude',mode:'default'}}, events:[] };
  const db = { getModeTransition: () => state.transition, getDrainFence: g => state.fences.get(g) ?? null,
    setDrainFence: (g,f) => { if (!state.fences.has(g)) state.fences.set(g,f); },
    insertControl: (content, options) => { state.wake = {content, ...options}; } };
  const deps = { store, db, readMode: () => ({mode:state.mode,legacy:state.keyPresent === false}), listRuns: () => state.runs, readRun: () => state.run,
    now: () => 1792000000123, diagnostic: event => state.events.push(event) };
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

test('unknown live identity and write failures never return false accepted', async t => {
  const f = fixture(t); f.state.runs = [{runId:'r1'}, {runId:null}];
  await assert.rejects(f.admission.handle(restart('unknown')), {code:'IDENTITY_UNAVAILABLE'}); assert.deepEqual(f.store.read(), []);
  f.state.runs = [{runId:'r1'}]; f.store.publish = () => {throw Object.assign(new Error('disk'),{code:'EIO'});};
  await assert.rejects(f.admission.handle(restart('disk')), {code:'EIO'}); assert.deepEqual(f.store.read(), []);
});

test('startup gate rejects restart and mode-switch requests and keeps start_attempt unclassified until ready', async t => {
  const f=fixture(t);f.admission.closeEntry();
  for(const request of [restart('a'),manual(),{version:1,type:'mode_switch',requestId:'m',target:'single'}]) {
    assert.equal((await f.admission.handle(request)).code,'entry_not_open');
  }
  await assert.rejects(f.admission.handle({version:1,type:'start_attempt',requestId:'start'}),{code:'START_ADMISSION_CLOSED'});
  assert.deepEqual(f.store.read(),[]);
});

// Frozen pre-change manual implementation is a compatibility fixture. It is
// statically defined, never read or reevaluated from product source at runtime.

const release = (overrides = {}) => ({ version: 1, type: 'request_release', requestId: 'release',
  sessionGroup: 'telegram:a', expectedRunId: 'r1', ...overrides });
test('release admission pins self run and orders mode, identity and conflicting work checks', async t => {
  const f = fixture(t); let calls = 0;
  f.admission.requestRelease = async run => { calls++; assert.equal(run.sessionGroup, 'telegram:a'); assert.equal(run.runId, 'r1'); return {ok:true,result:'accepted'}; };
  f.state.mode = 'single'; f.state.transition = {}; f.state.run = null;
  assert.equal((await f.admission.handle(release())).reason, 'not_multi');
  f.state.mode = 'multi'; assert.equal((await f.admission.handle(release())).reason, 'transition_open');
  f.state.transition = null; f.state.fences.set('*', {reason:'mode_switch'});
  assert.equal((await f.admission.handle(release())).reason, 'transition_open'); f.state.fences.clear();
  assert.equal((await f.admission.handle(release())).reason, 'run_changed');
  f.state.run = {runId:'other',ready:true}; assert.equal((await f.admission.handle(release())).reason, 'run_changed');
  f.state.run = {runId:'r1',ready:false}; assert.equal((await f.admission.handle(release())).reason, 'not_ready');
  f.state.run.ready = true;
  for (const reason of ['ttl','evict','upgrade','auth','model_config','delete']) {
    f.state.fences.set('telegram:a',{reason,runId:'r1'});
    assert.equal((await f.admission.handle(release())).reason, 'other_fence');
  }
  f.state.fences.set('telegram:a',{reason:'release',runId:'other'});
  assert.equal((await f.admission.handle(release())).reason, 'other_fence'); f.state.fences.clear();
  await f.admission.handle(manual({sessionGroup:'telegram:a'}));
  assert.equal((await f.admission.handle(release())).reason, 'manual_restart_pending'); f.store.write([]);
  assert.equal(calls,0); assert.equal((await f.admission.handle(release())).result,'accepted'); assert.equal(calls,1);
  f.state.fences.set('telegram:a',{reason:'release',runId:'r1'});
  assert.equal((await f.admission.handle(release({requestId:'retry'}))).result,'already_accepted'); assert.equal(calls,1);
});

