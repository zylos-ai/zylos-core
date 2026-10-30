import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { SupervisorLegacyStatus } from '../supervisor-legacy-status.js';
import { publishSessionStatus } from '../status-writer.js';
function fixture(t) {
  const f=readyTmuxTarget(t,{prefix:'supervisor-legacy-',mode:'single',runtimeProcess:true});
  f.tmux('new-session','-d','-s','claude-main','-e','ZYLOS_RUN_ID=',path.join(f.root,'claude'),'120');
  const pid=Number(f.tmux('display-message','-p','-t','=claude-main:','#{pane_pid}'));
  const dir=path.join(f.root,'activity-monitor'),foreground={version:1,session_id:'old-session',claude_pid:pid,runtime:'claude',observed_at:Date.now()};
  fs.writeFileSync(path.join(dir,'foreground-session.json'),JSON.stringify(foreground));
  const transcripts=path.join(f.root,'.claude/projects',f.root.replace(/\//g,'-'));fs.mkdirSync(transcripts,{recursive:true});
  fs.writeFileSync(path.join(transcripts,'old-session.jsonl'),'{}\n');
  const now=Date.now()+10000;fs.writeFileSync(path.join(transcripts,'new-unrelated.jsonl'),'{}\n');
  fs.utimesSync(path.join(transcripts,'new-unrelated.jsonl'),now/1000,now/1000);
  const observer=new SupervisorLegacyStatus({env:f.env,connectionOptions:{socketPath:f.socketPath,binary:f.binary},now:()=>now,readHealth:()=>({health:'ok'})});
  t.after(()=>observer.close());return {...f,dir,foreground,observer,now};
}
test('legacy and new Origin publish separate identities; newest unrelated transcript cannot make legacy busy', {timeout:15000}, async t=>{
  const f=fixture(t),legacy=await f.observer.tick();
  assert.equal(legacy.sessionId,'old-session');assert.equal(legacy.runId,null);assert.equal(legacy.state,'idle');
  const statusFile=path.join(f.root,'activity-monitor/session-groups/origin/agent-status.json');
  publishSessionStatus({statusFile,scene:{ready:true,runId:'run-1',sessionId:'session-1',runtime:'claude'},
    activity:{sessionId:'session-1',state:'busy',lastActivityAt:f.now,tools:[]},health:{health:'ok'},now:f.now});
  assert.equal(JSON.parse(fs.readFileSync(statusFile)).sessionId,'session-1');
  const oldFile=path.join(f.dir,'agent-status.json'),before=fs.readFileSync(oldFile,'utf8');
  assert.equal(JSON.parse(before).sessionId,'old-session');
  f.tmux('kill-session','-t','=claude-main');await f.observer.tick();assert.equal(fs.readFileSync(oldFile,'utf8'),before);
  assert.doesNotThrow(()=>f.tmux('has-session','-t','=zylos-group-origin'));
});
test('legacy foreground from another PID or unobservable tmux never publishes state', {timeout:15000}, async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'foreground-session.json'),JSON.stringify({...f.foreground,claude_pid:process.pid}));
  assert.equal(await f.observer.tick(),undefined);assert.equal(fs.existsSync(path.join(f.dir,'agent-status.json')),false);
  fs.writeFileSync(path.join(f.dir,'foreground-session.json'),JSON.stringify(f.foreground));
  f.observer.open=async()=>{throw Object.assign(new Error('timeout'),{code:'TMUX_UNAVAILABLE'});};
  await assert.rejects(f.observer.tick(),{code:'TMUX_UNAVAILABLE'});assert.equal(fs.existsSync(path.join(f.dir,'agent-status.json')),false);
});
