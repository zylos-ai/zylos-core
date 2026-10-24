import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateLaunchConfig } from '../session-command.js';
import { setupLaunch, assertGone } from './launch-tmux-fixture.js';
const models=['model#[fg=red]','model##[fg=red,bold]','model#[fg=red]#{pid},}#(echo ignored)\t"\n'];
for(const sessionGroup of [null,'telegram:literal']) for(const model of models) for(const mismatch of [false,true]) {
  test(`creation literal ${JSON.stringify(model)} mismatch=${mismatch} group=${sessionGroup}`,async t=>{
    const f=await setupLaunch(t);
    const original=f.tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim();
    f.tmux('set-environment','-g','ZYLOS_SESSION_GROUP','stale-global');
    const launchConfig={runtime:'claude',mode:'override',model,effort:'high'};
    assert.equal(validateLaunchConfig('claude',launchConfig,' --model MODEL --effort EFFORT '),true);
    const wrapper=await f.clientWrapper(mismatch?{...launchConfig,model:model+'-different'}:undefined);
    const pending=f.launch({launchConfig,sessionGroup,tmuxBinary:wrapper.file});
    if(mismatch) {
      await assert.rejects(pending,{code:'LAUNCH_FAILED'});
      assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'keeper','bad F2 must remove only the newly created session');
    } else {
      assert.equal((await pending).tmuxName,'target');
      const rows=f.tmux('show-environment','-t','=target').split('\n');
      assert.ok(rows.includes(`ZYLOS_MODEL_CONFIG=${JSON.stringify(launchConfig)}`));
      assert.ok(rows.includes('ZYLOS_RUN_ID=isolated-run'));
      if(sessionGroup===null)assert.ok(rows.includes('-ZYLOS_SESSION_GROUP'));
      else assert.ok(rows.includes(`ZYLOS_SESSION_GROUP=${sessionGroup}`));
    }
    assert.equal(f.tmux('show-environment','-g','ZYLOS_SESSION_GROUP').trim(),'ZYLOS_SESSION_GROUP=stale-global');
    assert.equal(f.tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim(),original);
    assert.equal((await fs.readFile(wrapper.calls,'utf8')).trim(),'create','one original client; no reconnect');
    assertGone(assert,Number(await fs.readFile(wrapper.pidFile,'utf8')));
  });
}
for(const inherited of ['stale-global',''])test(`single tombstone preserves global group ${JSON.stringify(inherited)}`,async t=>{
  const f=await setupLaunch(t);
  f.tmux('set-environment','-g','ZYLOS_SESSION_GROUP',inherited);
  await f.launch();
  assert.equal(f.tmux('show-environment','-t','=target','ZYLOS_SESSION_GROUP').trim(),'-ZYLOS_SESSION_GROUP');
  assert.equal(f.tmux('show-environment','-g','ZYLOS_SESSION_GROUP').trim(),`ZYLOS_SESSION_GROUP=${inherited}`);
});
