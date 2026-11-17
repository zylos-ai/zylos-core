import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Opt-in acceptance: real CLI, npm local install, private PM2, SQLite and tmux.
// Only distribution curl responses and runtime executables are fixtures. Skill
// dependency downloads are excluded by fixture metadata; Core bundles already
// provisioned dependencies; npm lifecycle scripts are disabled to prevent binary
// acquisition. Run when stop verification or recovery ownership changes; skip
// unless explicitly opted in with an absolute private-PM2 executable. No runtime source is rewritten or evaluated.
const enabled = process.env.ZYLOS_RUN_PRIVATE_UPGRADE_ACCEPTANCE === '1';
for (const scenario of ['stop-race', 'success']) test(`private real self-upgrade: ${scenario}`, {
  skip: !enabled, timeout: 360000,
}, () => {
  assert.ok(path.isAbsolute(process.env.ZYLOS_ACCEPTANCE_PM2 || ''),'provide absolute ZYLOS_ACCEPTANCE_PM2');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ua-')));
  fs.chmodSync(root,0o700);
  const env = {PATH:process.env.PATH,TZ:'Asia/Singapore', HOME:path.join(root,'h'), ZYLOS_DIR:path.join(root,'z'),
    PM2_HOME:path.join(root,'p'), TMPDIR:path.join(root,'t'), TMUX_TMPDIR:path.join(root,'t'),
    ZYLOS_ACCEPTANCE_PM2:process.env.ZYLOS_ACCEPTANCE_PM2,
    ZYLOS_ACCEPTANCE_DASHBOARD_MODULES:process.env.ZYLOS_ACCEPTANCE_DASHBOARD_MODULES,
    ZYLOS_ACCEPTANCE_EVIDENCE:process.env.ZYLOS_ACCEPTANCE_EVIDENCE};
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
    const result = spawnSync(process.execPath,[helper,root,scenario],{env,cwd:root,encoding:'utf8',timeout:330000,maxBuffer:8<<20,detached:true});
    childPid=result.pid;
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
  } finally {
    try {
      if(childPid)try{process.kill(-childPid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}
    } finally {
      try {
        const pm2 = env.ZYLOS_ACCEPTANCE_PM2;
        if (pm2 && fs.existsSync(path.join(env.PM2_HOME,'pm2.pid'))) {
          const killed=spawnSync(pm2,['kill'],{env,cwd:root,encoding:'utf8',timeout:20000});
          assert.equal(killed.status,0,killed.stderr);
        }
      } finally {
        try {
          spawnSync('/usr/bin/tmux',['-S',path.join(root,'t/s'),'kill-server'],{env,timeout:2000});
        } finally {
          fs.rmSync(root,{recursive:true,force:true});
        }
      }
    }
  }
});
