import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,service} from './stop-tmux-fixture.js';

for(const present of [true,false])test(`real tmux stop: present=${present}; independent same-run service and origin survive`,async t=>{
 const f=await fixture(t),key=randomUUID();
 if(present)f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
 const original=present?f.snapshot('target'):null;
 const independent=await service(f,key);
 await f.adapter.stop({tmuxName:'target',expectedRunId:key});
 assert.equal(f.command('list-sessions','-F','#{session_name}'),'origin');
 assert.equal(f.snapshot('origin'),f.origin);
 const preserved=await independent.verify();
 t.diagnostic(JSON.stringify({present,original,service:preserved,originUnchanged:true,targetAbsent:true}));
});
