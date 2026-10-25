import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const Database=createRequire(new URL('../../skills/comm-bridge/package.json',import.meta.url))('better-sqlite3');
import * as schema from '../../skills/comm-bridge/scripts/c4-schema.js';
import {guardDatabase} from '../../skills/comm-bridge/scripts/sqlite-schema.js';
import {isolatedTmux,tmuxClientEnv} from './isolated-tmux.js';

// Real F1/F3, ledger and tmux; optional named sleeper is not an authenticated runtime.
export function readyTmuxTarget(t,{prefix='c4-target-',mode='single',runtime='claude',
  runId='run-1',sessionId='session-1',runtimeProcess=false,ledger=true,packageRoot}={}) {
  let db;
  const f=isolatedTmux(t,{prefix,socketName:'tmux.sock',beforeCleanup:()=>db?.close()});
  const root=f.dir;
  const env=tmuxClientEnv(f,{PATH:process.env.PATH,HOME:root,ZYLOS_DIR:root,
    ZYLOS_PACKAGE_ROOT:packageRoot,LANG:'en_US.UTF-8'});
  fs.mkdirSync(path.join(root,'.zylos'));
  fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({runtime,session_mode:mode}));
  if(ledger){
    fs.mkdirSync(path.join(root,'comm-bridge'));
    db=new Database(path.join(root,'comm-bridge/c4.db'));guardDatabase(db,schema);db.pragma('journal_mode=WAL');
  }
  const readyPath=path.join(root,'activity-monitor/session-groups/origin/current-session.json');
  const ready={runId,sessionId,ts:1,startupControlIds:[]};
  fs.mkdirSync(path.dirname(readyPath),{recursive:true});fs.writeFileSync(readyPath,JSON.stringify(ready));
  let executable='/bin/sleep';
  if(runtimeProcess){
    executable=path.join(root,'claude');
    fs.writeFileSync(path.join(root,'fixture.c'),'#include <unistd.h>\nint main(void) { sleep(120); return 0; }\n');
    execFileSync('cc',[path.join(root,'fixture.c'),'-o',executable],{env,timeout:20000});
  }
  f.tmux('-f','/dev/null','new-session','-d','-s','zylos-group-origin',
    '-e',`ZYLOS_RUN_ID=${runId}`,'-e',`ZYLOS_MODEL_CONFIG=${JSON.stringify({runtime,mode:'default'})}`,
    ...(mode==='multi'?['-e','ZYLOS_SESSION_GROUP=origin']:[]),executable,'120');
  return {...f,root,env,db,readyPath,ready};
}
