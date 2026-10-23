import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionAdapter} from '../session-adapter.js';

const row=(pid=42)=>({pid,start:'100'});
function fixture({present=true,scans=()=>[row()],observe=async pid=>row(pid),pinFailure,sendFailure,closeFailure}={}) {
  const events=[];
  const adapter=new SessionAdapter({
    dependencies:{openTmuxConnection:async()=>({close:()=>events.push(['tmux-close']),
      didAcknowledgeSessionKill:()=>true,command:async args=>events.push(args)}),
    observeSessionTarget:async()=>({present,runId:'r',tmuxSessionId:'$1'}),
    revalidateSessionTarget:async()=>events.push(['validate'])},
    findRunProcesses:async()=>scans(),
    readOwnedProcess:async pid=>{events.push(['observe',pid]);return observe(pid)},
    pinProcess:async pid=>{
      events.push(['pin',pid]);if(pinFailure?.(pid))throw new Error('pin unavailable');
      return {signal:async sig=>{events.push(['signal',pid,sig]);if(sendFailure)throw new Error('send failed');return false},
        close:async()=>{events.push(['close',pid]);if(closeFailure?.(pid))throw new Error('close failed')}};
    },sleep:async()=>{},log:()=>events.push(['unknown']),
  });
  return {adapter,events,stop:()=>adapter.stop({tmuxName:'fixture',expectedRunId:'r'})};
}
test('pins before ownership revalidation and mutation, reuses handle for TERM/KILL, closes once',async()=>{
  let scans=0;
  const f=fixture({scans:()=>++scans<4?[row()]:[]});
  await f.stop();
  assert.deepEqual(f.events.slice(0,4),[['pin',42],['observe',42],['validate'],['kill-session','-t','$1']]);
  assert.deepEqual(f.events.filter(e=>e[0]==='pin'),[['pin',42]]);
  assert.deepEqual(f.events.filter(e=>e[0]==='signal'),[['signal',42,'SIGTERM'],['signal',42,'SIGKILL']]);
  assert.deepEqual(f.events.filter(e=>e[0]==='close'),[['close',42]]);
});
test('partial acquisition failure closes earlier handles before any tmux mutation',async()=>{
  const f=fixture({scans:()=>[row(42),row(43)],pinFailure:pid=>pid===43});
  await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
  assert.deepEqual(f.events.filter(e=>e[0]==='close'),[['close',42]]);
  assert.equal(f.events.some(e=>e[0]==='kill-session'||e[0]==='signal'),false);
});
test('post-pin identity replacement and ownership read errors close handle and refuse mutation',async()=>{
  for(const observe of [async pid=>({pid,start:'101'}),async()=>{throw new Error('unreadable')}]) {
    const f=fixture({observe});await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
    assert.deepEqual(f.events.filter(e=>e[0]==='close'),[['close',42]]);
    assert.equal(f.events.some(e=>e[0]==='kill-session'||e[0]==='signal'),false);
  }
});
test('send failure and unsuccessful disappearance confirmation close all handles',async()=>{
  for(const sendFailure of [true,false]) {
    const f=fixture({present:false,sendFailure});await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
    assert.deepEqual(f.events.filter(e=>e[0]==='close'),[['close',42]]);
    assert.equal(f.events.some(e=>e[0]==='unknown'),false);
  }
});
test('re-enumeration pins new matching descendant; stale handle cannot substitute for scan',async()=>{
  let scans=0;
  const f=fixture({present:false,scans:()=>[ [row(42)], [row(42),row(43)], [] ][scans++]});
  await f.stop();
  assert.deepEqual(f.events.filter(e=>e[0]==='pin'),[['pin',42],['pin',43]]);
  assert.deepEqual(f.events.filter(e=>e[0]==='signal'),[['signal',42,'SIGTERM'],['signal',42,'SIGKILL'],['signal',43,'SIGKILL']]);
  assert.deepEqual(f.events.filter(e=>e[0]==='close'),[['close',42],['close',43]]);
});
test('re-enumeration error is unconfirmed and still closes the pinned handle',async()=>{
  let scans=0;const f=fixture({present:false,scans:()=>{if(scans++)throw new Error('scan failed');return [row()]}});
  await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
  assert.deepEqual(f.events.filter(e=>e[0]==='close'),[['close',42]]);
  assert.equal(f.events.some(e=>e[0]==='unknown'),false);
});
test('one close failure cannot prevent the other handles from closing',async()=>{
  let scans=0;const f=fixture({present:false,scans:()=>scans++?[]:[row(42),row(43)],closeFailure:pid=>pid===42});
  await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
  assert.deepEqual(f.events.filter(e=>e[0]==='close'),[['close',42],['close',43]]);
});
test('missing signalling capability is not the absent/lookup-unavailable success exception',async()=>{
  const f=fixture({present:false,pinFailure:()=>true});await assert.rejects(f.stop(),{code:'STOP_UNCONFIRMED'});
  assert.equal(f.events.some(e=>e[0]==='unknown'),false);
});
test('gone before handle acquisition sends nothing; only subsequent empty scan permits success',async()=>{
  let scans=0;const f=fixture({present:false,scans:()=>scans++?[]:[row()]});
  f.adapter.options.pinProcess=async()=>null;
  await f.stop();assert.equal(f.events.some(e=>e[0]==='signal'),false);
  assert.equal(scans,2);
});
