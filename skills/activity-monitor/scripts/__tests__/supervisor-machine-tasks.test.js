import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueMachineControl } from '../machine-control.js';

test('all machine notices select Origin in multi and NULL single without fallback',async()=>{
  for(const mode of ['single','multi']) {
    let args;const result=await enqueueMachineControl(['enqueue','--content','notice','--priority','3','--no-ack-suffix'],{readMode:()=>({mode}),run:input=>{args=input;return {ok:false,output:'TRANSITION_OPEN'};}});
    assert.equal(result.ok,false);assert.equal(args.includes('--group'),mode==='multi');
    if(mode==='multi')assert.equal(args.at(-1),'origin');
  }
  await assert.rejects(enqueueMachineControl([],{readMode:()=>{throw new Error('unreadable');},run:()=>{throw new Error('must not run');}}),/unreadable/);
});

