import test from 'node:test';
import assert from 'node:assert/strict';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { SupervisorExits } from '../supervisor-exits.js';
function setup(t) {
 const f=readyTmuxTarget(t,{prefix:'p05-runtime-exit-',mode:'multi',runtimeProcess:true});
 const db=createStore(f.db,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'multi'}})});
 const scenes=new SupervisorScenes({env:f.env,connectionOptions:{socketPath:f.socketPath,binary:f.binary},readMode:()=>({mode:'multi'}),readActivity:()=>({state:'idle'}),readUsage:()=>null});
 const events=[],errors=[];
 const exits=new SupervisorExits({scenes,db,env:f.env,readMode:()=>({mode:'multi'}),serialize:fn=>fn(),diagnostic:event=>events.push(event),reportError:error=>errors.push(error)});
 return {f,db,scenes,exits,events,errors};
}
// P05 T01: actual isolated process exit + SQLite authorities + pinned adapter stop.
test('runtime SIGKILL removes only its exited managed session and records crash', {timeout:15000},async t=>{
 const {f,scenes,exits,events,errors}=setup(t);
 f.tmux('new-session','-d','-s','fixture-manual','sleep','120');
 // Keep a shell alive after its runtime child exits so cleanup must call stop.
 f.tmux('respawn-pane','-k','-t','=zylos-group-origin:0',`${f.root}/claude & wait; sleep 120`);
 const before=await scenes.observe();assert.equal(before[0].processRunning,true);await exits.advance(before);
 process.kill(before[0].runtimePid,'SIGKILL');
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=zylos-group-origin'));
 await exits.advance(await scenes.observe());
 assert.equal(events.length,1);assert.equal(events[0].event,'crash_detected');assert.deepEqual(errors,[]);
 assert.equal((await scenes.observeGroup('origin')).present,false);
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-manual'));
 await exits.advance(await scenes.observe());assert.equal(events.length,1);
});
test('actual SQLite fence suppresses crash classification after runtime SIGKILL', {timeout:15000},async t=>{
 const {f,db,scenes,exits,events}=setup(t);
 // Keep the isolated server alive while its managed pane exits, so this test
 // observes fence ownership rather than racing the last-session shutdown.
 f.tmux('new-session','-d','-s','fixture-manual','sleep','120');
 const before=await scenes.observe();await exits.advance(before);
 db.setDrainFence('origin',{reason:'upgrade',runId:'run-1'});
 process.kill(before[0].runtimePid,'SIGKILL');await exits.advance(await scenes.observe());
 assert.equal(events.length,0);assert.equal(db.getDrainFence('origin').runId,'run-1');
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-manual'));
});
