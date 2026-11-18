import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';

const repo=path.resolve(import.meta.dirname,'..');
const find=name=>String(process.env.PATH).split(path.delimiter).map(dir=>path.join(dir,name)).find(file=>{try{return fs.statSync(file).isFile();}catch{return false;}});
const pm2=find('pm2'),npm=find('npm'),tmux=find('tmux');
// Boundary: real upgrade entry/admission, transaction, PM2 stop, SQLite
// rehearsal/snapshot/verification and frozen recovery. Dashboard is an equivalent
// SQLite writer under PM2, with a fixture owner migration. No package is installed:
// the install seam stops at the prepared boundary and real recovery restores it.
// Run after changes to upgrade ordering, maintenance stop, snapshots or recovery.
// Full `zylos upgrade --self` and post-install Dashboard completion still require
// release acceptance; this test does not claim those boundaries.
// All cases require explicit opt-in and available local PM2/npm/tmux and SQLite
// dependencies. The large case allocates about 1 GB plus temporary backup copies.
for(const [scenario,megabytes] of [['large',1024],['failure-running',1],['failure-stopped',1],['unchanged',1]]) {
  test(`offline database preparation and recovery (${scenario})`,{
    skip:process.env.ZYLOS_UPGRADE_DB_INTEGRATION!=='1'?'requires ZYLOS_UPGRADE_DB_INTEGRATION=1':!pm2||!npm||!tmux?'local PM2/npm/tmux unavailable':false,
    timeout:240000,
  },async t=>{
    // A short, canonical private root also keeps PM2/tmux Unix sockets portable.
    const root=fs.realpathSync(fs.mkdtempSync('/tmp/ud-'));
    const dirs={HOME:path.join(root,'h'),ZYLOS_DIR:path.join(root,'z'),PM2_HOME:path.join(root,'p'),TMPDIR:path.join(root,'t'),TMUX_TMPDIR:path.join(root,'t')};
    for(const dir of new Set(Object.values(dirs)))fs.mkdirSync(dir);
    const bin=path.join(root,'bin');fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath,path.join(bin,'node'));
    fs.symlinkSync(fs.realpathSync(pm2),path.join(bin,'pm2'));
    fs.symlinkSync(fs.realpathSync(npm),path.join(bin,'npm'));
    const socket=path.join(root,'t/private.sock');
    fs.writeFileSync(path.join(bin,'tmux'),'#!/bin/sh\nexec '+JSON.stringify(fs.realpathSync(tmux))+' -S '+JSON.stringify(socket)+' "$@"\n',{mode:0o700});
    const env={...dirs,PATH:[bin,'/usr/bin','/bin'].join(path.delimiter),TZ:'Asia/Singapore',
      XDG_CONFIG_HOME:path.join(dirs.HOME,'.config'),CODEX_HOME:path.join(dirs.HOME,'.codex'),
      npm_config_cache:path.join(root,'cache'),npm_config_globalconfig:path.join(root,'npmrc'),
      UPGRADE_EVENTS:path.join(root,'events.jsonl'),UPGRADE_FAIL_MIGRATION:scenario.startsWith('failure')?'1':'0'};
    fs.writeFileSync(env.npm_config_globalconfig,'');
    const helper=path.join(repo,'test/helpers/run-upgrade-db-maintenance.mjs');
    for(const key of Object.keys(dirs)){assert.equal(fs.realpathSync(env[key]),env[key]);assert.ok(env[key].startsWith(root+'/'));}
    assert.ok(Buffer.byteLength(socket)<100);assert.ok(Buffer.byteLength(path.join(env.PM2_HOME,'rpc.sock'))<100);
    assert.match(fs.readFileSync(path.join(bin,'tmux'),'utf8'),new RegExp(socket.replaceAll('/','\\/')));
    assert.equal(fs.realpathSync(path.join(bin,'pm2')),fs.realpathSync(pm2));
    t.diagnostic(JSON.stringify({command:process.execPath,args:[helper,root,scenario,String(megabytes)],env,socket,database:path.join(env.ZYLOS_DIR,'components/dashboard/dashboard.db')}));
    let child,output='',bytes=0,overflow=false;
    const kill=()=>{if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}};
    // PM2 daemonizes out of the driver process group. Always stop its private
    // daemon, including timeout/failure, before removing its private HOME.
    t.after(()=>{kill();const stopped=spawnSync(path.join(bin,'pm2'),['kill'],{env,encoding:'utf8',timeout:20000});
      assert.ifError(stopped.error);assert.equal(stopped.status,0,stopped.stderr);
      spawnSync(path.join(bin,'tmux'),['kill-server'],{env,timeout:2000,stdio:'ignore'});
      fs.rmSync(root,{recursive:true,force:true});});
    child=spawn(process.execPath,[helper,root,scenario,String(megabytes)],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
    const collect=data=>{bytes+=data.length;if(bytes>65536){overflow=true;kill();return;}output+=data.toString();};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timer=setTimeout(kill,210000);
    let result;
    try{result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});}
    finally{clearTimeout(timer);kill();}
    assert.equal(overflow,false,'bounded fixture output');assert.equal(result.code,0,output);
    const report=JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(report.scenario,scenario);assert.ok(report.writerTransactions>0);
    t.diagnostic(JSON.stringify(report));
  });
}
