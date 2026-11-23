import test from 'node:test';
import assert from 'node:assert/strict';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { SupervisorServerHealth } from '../supervisor-server-health.js';
import { SupervisorServerObservation } from '../supervisor-server-observation.js';
const unavailable = (cause='timeout') => Object.assign(new Error(cause), { code: 'TMUX_UNAVAILABLE', cause });
function fixture(cause='timeout') {
  let now = 0, failed = false;
  const scene = { sessionGroup: 'origin', runId: 'old', runtime: 'claude', present: true, ready: true,
    processRunning: true, tmuxTarget: { serverGeneration: '123:5', sessionId: '$1', paneId: '%1' } };
  const alerts = [];
  const guard = new SupervisorServerHealth({ now: () => now, sendAlert: (...args) => alerts.push(args) });
  const base = { observe: async () => { if (failed) throw unavailable(cause); return [scene]; },
    observeGroup: async () => { if (failed) throw unavailable(cause); return scene; },
    readRun: async () => { if (failed) throw unavailable(cause); return scene; },
    readIdentity: async () => { if (failed) throw unavailable(cause); return scene; },
    bindTarget: async () => { if (failed) throw unavailable(cause); return {expectedRunId:scene.runId,tmuxTarget:scene.tmuxTarget}; },
    listRuns: async () => { if (failed) throw unavailable(cause); return [scene]; } };
  const provider = new SupervisorServerObservation(base, { guard });
  return { provider, base, guard, scene, alerts, setFailure: v => failed = v, advance: ms => now += ms };
}
test('unavailable occupancy remains unknown after ten minutes without synthetic exits', async () => {
  const f = fixture(); await f.provider.observe(); f.setFailure(true);
  await f.provider.observe(); f.advance(600000);
  const [unknown] = await f.provider.observe();
  assert.equal(unknown.present,true); assert.equal(unknown.ready,false);
  assert.deepEqual(await f.provider.advance(),{status:'unavailable'});
  assert.equal(f.alerts.length,1);
});

// observation failure never authorizes termination.
test('prolonged timeout and command errors never signal or end the real isolated server',{timeout:15000},async t=>{
  const f=readyTmuxTarget(t,{prefix:'server-observe-only-',mode:'multi',ledger:false});
  let now=0,cause=null;const alerts=[];
  const base=new SupervisorScenes({env:f.env,connectionOptions:{socketPath:f.socketPath,binary:f.binary},
    readMode:()=>({mode:'multi'}),readActivity:()=>({state:'idle',idleSince:0}),readUsage:()=>null});
  const observe=base.observe.bind(base);
  base.observe=async context=>{if(cause)throw unavailable(cause);return observe(context);};
  const guard=new SupervisorServerHealth({now:()=>now,sendAlert:(target,message)=>alerts.push({target,message})});
  const provider=new SupervisorServerObservation(base,{guard,socketKey:f.socketPath});
  const before=f.tmux('display-message','-p','-t','=zylos-group-origin','#{pid}:#{session_id}:#{pane_pid}');
  assert.equal((await provider.observe())[0].present,true);
  const signals=[];const originalKill=process.kill;
  const spy=t.mock.method(process,'kill',(pid,signal)=>{
    signals.push({pid,signal});
    if(signal===0)return originalKill.call(process,pid,signal);
    throw new Error('Observation attempted to signal a process');
  });
  try{
    for(const kind of ['timeout','error']){
      cause=kind;
      for(const elapsed of [0,60000,600000,1800000,24*60*60000]){
        now+=elapsed;
        const [unknown]=await provider.observe();
        assert.equal(unknown.present,true);assert.equal(unknown.ready,false);assert.equal(unknown.observationError.cause,kind);
        assert.deepEqual(await provider.advance(),{status:'unavailable'});
        assert.deepEqual(signals,[],'observation must not probe or signal server processes');
        assert.equal(f.tmux('display-message','-p','-t','=zylos-group-origin','#{pid}:#{session_id}:#{pane_pid}'),before);
      }
      cause=null;await provider.observe();assert.deepEqual(await provider.advance(),{status:'observable'});
    }
    assert.ok(alerts.length>=2);assert.deepEqual(signals,[]);
  }finally{spy.mock.restore();}
});
