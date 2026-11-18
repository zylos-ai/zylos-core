import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Run only in isolation; never touch live resources. Isolate HOME, ZYLOS_DIR,
// PM2_HOME and short TMPDIR; reserve a private tmux socket and test databases.
// This fixture does not start a tmux server. It covers real CLI + local npm + PM2
// success and service names in stop-verification errors. Run when those paths or
// this fixture change; skip unrelated changes or without explicit opt-in and
// preprovisioned dependencies. Distribution/runtime responses are fixtures;
// dependency downloads and npm lifecycle acquisition are excluded.
const enabled = process.env.ZYLOS_RUN_PRIVATE_UPGRADE_ACCEPTANCE === '1';
for (const scenario of ['stop-race', 'success']) test(`private real self-upgrade: ${scenario}`, {
  skip: !enabled, timeout: 360000,
}, () => {
  assert.ok(path.isAbsolute(process.env.ZYLOS_ACCEPTANCE_PM2 || ''),'provide absolute ZYLOS_ACCEPTANCE_PM2');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/ua-'));
  fs.chmodSync(root,0o700);
  const env = {PATH:process.env.PATH,TZ:'Asia/Singapore', HOME:path.join(root,'h'), ZYLOS_DIR:path.join(root,'z'),
    PM2_HOME:path.join(root,'p'), TMPDIR:path.join(root,'t'), TMUX_TMPDIR:path.join(root,'t')};
  for (const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR']) {
    fs.mkdirSync(env[key]); assert.equal(fs.realpathSync(env[key]), env[key]);
    assert.ok(env[key].startsWith(root + path.sep));
  }
  assert.ok(Buffer.byteLength(path.join(env.PM2_HOME,'rpc.sock'))<100);
  assert.ok(Buffer.byteLength(path.join(root,'t/s'))<100);
  const helper = path.join(import.meta.dirname,'helpers/private-self-upgrade.mjs');
  console.log('Private self-upgrade isolation:', JSON.stringify({scenario, root, helper, env,
    database:path.join(env.ZYLOS_DIR,'comm-bridge/c4.db'), tmuxSocket:path.join(root,'t/s')}));
  let childPid;
  try {
    const result = spawnSync(process.execPath,[helper,root,scenario,process.env.ZYLOS_ACCEPTANCE_PM2,
      process.env.ZYLOS_ACCEPTANCE_DASHBOARD_MODULES || '',process.env.ZYLOS_ACCEPTANCE_EVIDENCE || ''],{env,cwd:root,encoding:'utf8',timeout:330000,maxBuffer:8<<20,detached:true});
    childPid=result.pid;
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
  } finally {
    const failures=[];
    if(childPid)try{process.kill(-childPid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')failures.push(e.message);}
    const killed=spawnSync(process.env.ZYLOS_ACCEPTANCE_PM2,['kill'],{env,cwd:root,encoding:'utf8',timeout:20000});
    if(killed.status!==0)failures.push(`pm2 kill exit=${killed.status}: ${killed.error?.message || killed.stderr}`);
    const socket=path.join(root,'t/s');
    const tmux=spawnSync('/usr/bin/tmux',['-S',socket,'kill-server'],{env,cwd:root,encoding:'utf8',timeout:2000});
    if(tmux.error || (tmux.status!==0 && !/no server running|No such file or directory/.test(tmux.stderr)))
      failures.push(`tmux stop exit=${tmux.status}: ${tmux.error?.message || tmux.stderr}`);
    const residual=[];
    try {
      for(const pid of fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name))) {
        try {
          if(fs.statSync(`/proc/${pid}`).uid!==process.getuid())continue;
          const home=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').find(v=>v.startsWith('HOME='))?.slice(5);
          let cwd;try{cwd=fs.readlinkSync(`/proc/${pid}/cwd`);}catch(e){if(e.code!=='ENOENT')throw e;}
          if([home,cwd].some(value=>value===root || value?.startsWith(root+path.sep)))residual.push(Number(pid));
        }catch(e){if(e.code!=='ENOENT' && e.code!=='ESRCH')throw e;}
      }
    }catch(e){failures.push(`process inspection failed: ${e.message}`);}
    if(residual.length)failures.push('processes remain');
    assert.equal(failures.length,0,`Cleanup failed; preserved root=${root}; residual PIDs=${residual.join(',') || '(none)'}; ${failures.join('; ')}`);
    fs.rmSync(root,{recursive:true,force:true});
  }
});
