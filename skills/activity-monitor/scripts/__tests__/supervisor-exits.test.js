import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorExits } from '../supervisor-exits.js';
function fixture() {
 const events=[],stops=[];let transition=null,fence=null;
 const scene={sessionGroup:'telegram:one',runId:'r1',runtime:'codex',sessionId:'s1',ready:true,present:true,processRunning:true,currentSessionTs:100,tmuxTarget:{serverGeneration:'1:1'}};
 let current={...scene};
 const scenes={observeGroup:async()=>current,stop:async value=>{stops.push(value);current={present:false};}};
 const observer=new SupervisorExits({scenes,db:{getModeTransition:()=>transition,getDrainFence:()=>fence},serialize:fn=>fn(),readMode:()=>({mode:'multi'}),diagnostic:event=>events.push(event),stat:async()=>({mtimeMs:99})});
 return {observer,scene,events,stops,set:value=>{current=value;},gate:value=>{transition=value;},fence:value=>{fence=value;}};
}
test('exited runtime is stopped and confirmed before crash diagnostic; no restart',async()=>{
 const f=fixture();await f.observer.advance([f.scene]);const stopped={...f.scene,processRunning:false};f.set(stopped);await f.observer.advance([stopped]);assert.equal(f.stops.length,1);assert.equal(f.events[0].event,'crash_detected');await f.observer.advance([]);assert.equal(f.events.length,1);
});
test('same-run session change and fresh handoff are rotation diagnostics',async()=>{
 const f=fixture();await f.observer.advance([f.scene]);const next={...f.scene,sessionId:'s2'};f.set(next);await f.observer.advance([next]);assert.equal(f.events[0].event,'rotate_done');f.observer.stat=async()=>({mtimeMs:101});f.set({present:false});await f.observer.advance([]);assert.equal(f.events[1].event,'rotate_done');assert.equal(f.stops.length,0);
});
test('/ retain ownership of stopped runtimes',async()=>{
 for(const gate of ['gate','fence']){const f=fixture();await f.observer.advance([f.scene]);f[gate]({id:'gate'});f.set({...f.scene,processRunning:false});await f.observer.advance([{...f.scene,processRunning:false}]);assert.equal(f.stops.length,0);assert.equal(f.events.length,0);}
});
test('unknown occupancy and replacement runs never authorize stopping the replacement',async()=>{
 const f=fixture();await f.observer.advance([f.scene]);f.set({present:true,runId:null});await f.observer.advance([{sessionGroup:f.scene.sessionGroup,present:true,runId:null}]);assert.equal(f.events.length,0);const next={...f.scene,runId:'r2'};f.set(next);await f.observer.advance([next]);assert.equal(f.events.length,1);assert.equal(f.stops.length,0);
});
test('successful adapter stop is final; no caller post-stop observation',async()=>{
 const f=fixture();await f.observer.advance([f.scene]);
 const stopped={...f.scene,processRunning:false};f.set(stopped);
 let observations=0;const observe=f.observer.scenes.observeGroup;
 f.observer.scenes.observeGroup=async()=>{assert.equal(++observations,1);return observe();};
 await f.observer.advance([stopped]);assert.equal(observations,1);assert.equal(f.stops.length,1);assert.equal(f.events.length,1);
});
