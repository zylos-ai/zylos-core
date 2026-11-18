import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SessionAdapter } from '../session-adapter.js';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';

// Exercises the real shared adapter, argv builder, launch script and tmux
// settlement. Fake executors only capture their inherited environment/argv.
// Run for launch environment changes; runtime-specific authentication can skip.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; each case owns
// a private socket and fixture. isolatedTmux kills its server before cleanup.
for (const runtime of ['claude','codex']) for (const [mode,group] of [
  ['single','origin'], ['multi','origin'], ['multi','telegram:launch'], ['single',null],
]) test(`${runtime} ${mode} launch preserves environment group ${group}`, async t => {
  let receiverPid;
  const fixture = isolatedTmux(t,{prefix:'origin-launch-', beforeCleanup:async () => {
    try { fixture.tmux('kill-server'); } catch {}
    await fixture.waitForServerExit();
    if (receiverPid) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try { process.kill(receiverPid,0); }
        catch (error) { if (error.code === 'ESRCH') return; throw error; }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail('Executor must exit before removing its fixture directory');
    }
  }});
  const root = fs.realpathSync(fixture.dir);
  const home = path.join(root,'home'); fs.mkdirSync(home);
  const executable = path.join(root,'executor');
  const output = path.join(root,'observed.json');
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(output)},JSON.stringify({group:process.env.ZYLOS_SESSION_GROUP ?? null,runId:process.env.ZYLOS_RUN_ID,args:process.argv.slice(2)}));\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  class Adapter extends SessionAdapter { get runtimeId() { return runtime; } }
  const adapter = new Adapter({root,env:{HOME:home,PATH:process.env.PATH,ZYLOS_SESSION_GROUP:'inherited-wrong'},
    runtimeExecutable:()=>executable, runtimeHelp:async()=>' --no-daemon ',
    tmux:{binary:fixture.binary,socketPath:fixture.socketPath,configFile:'/dev/null'}});
  console.info('launch isolation',JSON.stringify({root,home,pm2:process.env.PM2_HOME,tmp:process.env.TMPDIR,socket:fixture.socketPath,runtime,mode,group}));
  const launched = await adapter.launch({sessionGroup:group,runId:'origin-test',sessionMode:mode,launchConfig:{runtime,mode:'default'}});
  receiverPid = Number(fixture.tmux('display-message','-p','-t',`=${launched.tmuxName}`,'#{pane_pid}'));
  assert.equal(launched.tmuxName,group === 'telegram:launch' ? 'zylos-group-telegram=launch' : 'zylos-group-origin');
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(output) && Date.now() < deadline) await new Promise(resolve=>setTimeout(resolve,10));
  const observed = JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(observed.group,group);
  assert.equal(observed.runId,'origin-test');
  assert.equal(fixture.tmux('show-environment','-t',`=${launched.tmuxName}`,'ZYLOS_SESSION_GROUP'), group === null ? '-ZYLOS_SESSION_GROUP' : `ZYLOS_SESSION_GROUP=${group}`);
  if(runtime === 'codex') assert.ok(observed.args.some(arg=>arg.includes('env_vars=["ZYLOS_SESSION_GROUP","ZYLOS_RUN_ID","ZYLOS_DIR"]')));
});
