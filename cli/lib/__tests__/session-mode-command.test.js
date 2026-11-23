import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSessionMode } from '../../commands/session-mode.js';

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
