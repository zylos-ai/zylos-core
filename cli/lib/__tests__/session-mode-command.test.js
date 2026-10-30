import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSessionMode, sessionModeCommand } from '../../commands/session-mode.js';

for (const args of [[], ['switch'], ['switch','bad'], ['switch','multi','extra'], ['switch','multi','--force'], ['switch','multi','--json','--json']]) {
  test(`invalid arguments never submit: ${JSON.stringify(args)}`, async () => {
    let calls = 0;
    const result = await executeSessionMode(args, { send: () => { calls++; } });
    assert.equal(result.error.code, 'INVALID_ARGUMENT'); assert.deepEqual(result.error.persisted, []); assert.equal(calls, 0);
  });
}
for (const target of ['single', 'multi']) for (const kind of ['accepted', 'noop']) {
  test(`${target} ${kind} submits once with one absolute deadline`, async () => {
    const calls = [];
    const result = await executeSessionMode(['switch',target,'--json'], {
      now: () => 1000, requestId: () => 'request-1',
      send: async (request, options) => { calls.push({request,options}); return { kind: 'accepted', sent: true, reply: { result: kind, ...(kind === 'accepted' ? {runId:'run-1'} : {}) } }; },
      lookup: () => assert.fail('known acceptance needs no lookup'),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { request: { version:1, type:'mode_switch', requestId:'request-1', target }, options:{ deadlineAt:11000 } });
    assert.equal(result.ok,true); assert.equal(result.data.result,kind);
  });
}
for (const code of ['transition_open','config_unreadable','legacy_session_present','manual_restart_pending','requests_unreadable','entry_not_open','invalid_request']) {
  test(`${code} is returned without retry or lookup`, async () => {
    let calls = 0;
    const result = await executeSessionMode(['switch','multi'], {
      send: async () => { calls++; return { kind:'rejected',sent:true,reply:{code,...(code==='transition_open'?{runId:'run-2',target:'single'}:{})} }; },
      lookup: () => assert.fail('rejection needs no lookup'),
    });
    assert.equal(calls,1); assert.equal(result.error.code,code); assert.deepEqual(result.error.persisted,[]);
    if (code==='transition_open') assert.equal(result.error.runId,'run-2');
  });
}
for (const kind of ['connect_failed','deadline_exceeded']) test(`unsent ${kind} is known unsubmitted`, async () => {
  const result = await executeSessionMode(['switch','multi'], { send: async () => ({kind,sent:false}), lookup: () => assert.fail('unsent') });
  assert.equal(result.error.code,kind); assert.deepEqual(result.error.persisted,[]);
});
for (const kind of ['no_reply','invalid_reply','timeout','deadline_exceeded']) for (const observed of ['accepted','done','unknown','deadline_exceeded','throw']) {
  test(`${kind} observes ${observed} without resetting deadline or retrying`, async () => {
    const calls=[];
    const result = await executeSessionMode(['switch','multi'], {
      deadlineAt:12345,
      send: async (request, options) => { calls.push(['send',options]); return {kind,sent:true}; },
      lookup: async (target, options) => { calls.push(['lookup',target,options]); if(observed==='throw') throw new Error('read failed'); return observed; },
    });
    assert.deepEqual(calls,[['send',{deadlineAt:12345}],['lookup','multi',{deadlineAt:12345}]]);
    assert.equal(result.ok,['accepted','done'].includes(observed));
    if(result.ok) assert.equal(result.data.observed,observed==='accepted'?'transition_open':'target_mode');
    else { assert.equal(result.error.code,kind); assert.equal(result.error.persisted,null); }
  });
}
test('JSON command emits exactly one envelope and rejects with exit 1', async t => {
  const previous=process.exitCode; t.after(()=>{process.exitCode=previous;});
  const output=[]; t.mock.method(console,'log',line=>output.push(line)); t.mock.method(console,'error',()=>assert.fail('JSON uses stdout'));
  await sessionModeCommand(['switch','bad','--json']);
  assert.equal(process.exitCode,1); assert.equal(output.length,1); assert.equal(JSON.parse(output[0]).ok,false);
});
