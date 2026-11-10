import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const maintenance = createRequire(import.meta.url)('../../upgrade-maintenance.cjs');

export function serviceRestartFixture(t, {ecosystem = true, names = ['scheduler']} = {}) {
  // Linux test runners may use noexec shared memory; PM2 stand-ins need exec.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'linux' ? '/tmp' : os.tmpdir(), 'usr-')));
  const env = {HOME:path.join(root,'h'), ZYLOS_DIR:path.join(root,'h/zylos'), PM2_HOME:path.join(root,'p'),
    TMPDIR:path.join(root,'t'), TMUX_TMPDIR:path.join(root,'x'), XDG_CONFIG_HOME:path.join(root,'h/.config'),
    CODEX_HOME:path.join(root,'h/.codex'), PATH:path.join(root,'bin')+path.delimiter+process.env.PATH};
  for (const dir of Object.values(env).filter(value => value.startsWith(root) && !value.includes(path.delimiter))) fs.mkdirSync(dir,{recursive:true});
  const previous = Object.fromEntries(Object.keys(env).map(key => [key,process.env[key]]));
  Object.assign(process.env,env);
  t.after(() => {
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root,{recursive:true,force:true});
  });
  const skillsDir = path.join(env.ZYLOS_DIR,'.claude/skills');
  const scripts = Object.fromEntries(['scheduler','custom-service'].map(name => [name,path.join(skillsDir,name,'service.js')]));
  for (const script of Object.values(scripts)) {fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(script,'setInterval(()=>{},1000);');}
  const file = path.join(env.ZYLOS_DIR,'pm2/ecosystem.config.cjs');
  if (ecosystem) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,`module.exports={apps:${JSON.stringify(names.map(name => ({name,script:scripts[name]})))}};`,{mode:0o600});
  }
  const state = path.join(root,'state.json'), calls = path.join(root,'calls.jsonl'), environments = path.join(root,'environments.jsonl'), failure = path.join(root,'failure'), listLimit=path.join(root,'list-limit');
  const record = (name,status = 'stopped') => ({name,pid:status==='online'?123:0,pm2_env:{status,pm_exec_path:scripts[name]}});
  fs.writeFileSync(state,JSON.stringify([record('scheduler'),record('custom-service')]));
  fs.mkdirSync(path.join(root,'bin'));
  const pm2 = path.join(root,'bin/pm2');
  fs.writeFileSync(pm2,`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2),state=${JSON.stringify(state)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
fs.appendFileSync(${JSON.stringify(environments)},JSON.stringify({args,env:Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','PATH','SERVICE_SENTINEL','ZYLOS_RUN_ID','ZYLOS_SESSION_GROUP'].filter(key=>Object.hasOwn(process.env,key)).map(key=>[key,process.env[key]]))})+'\\n');
let records=JSON.parse(fs.readFileSync(state));
if(args[0]==='jlist'){
 if(fs.existsSync(${JSON.stringify(listLimit)})&&fs.readFileSync(${JSON.stringify(calls)},'utf8').trim().split('\\n').map(JSON.parse).filter(args=>args[0]==='jlist').length>Number(fs.readFileSync(${JSON.stringify(listLimit)}))){console.error('list unavailable');process.exit(1);}
 console.log(JSON.stringify(records));process.exit(0);}
if(args[0]==='save')process.exit(0);
if(args[0]==='stop'){const record=records.find(item=>item.name===args[1]);if(!record)process.exit(3);record.pid=0;record.pm2_env.status='stopped';fs.writeFileSync(state,JSON.stringify(records));process.exit(0);}
if(fs.existsSync(${JSON.stringify(failure)})){console.error('restart failed');process.exit(1);}
let names=[];
if(args[0]==='restart')names=[args[1]];
else if(['start','startOrRestart'].includes(args[0])){
 const config=require(args[1]),only=args[args.indexOf('--only')+1];names=config.apps.filter(app=>app.name===only).map(app=>app.name);
}else {console.error('unexpected PM2 command');process.exit(2);}
for(const name of names){const record=records.find(item=>item.name===name);if(!record)process.exit(3);record.pid=123;record.pm2_env.status='online';}
fs.writeFileSync(state,JSON.stringify(records));
`,{mode:0o700});
  assert.equal(fs.realpathSync(pm2),pm2);
  for (const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR']) assert.ok(process.env[key].startsWith(root+path.sep));
  assert.equal(process.env.PATH.split(path.delimiter)[0],path.join(root,'bin'));
  const j = {zylosDir:env.ZYLOS_DIR,skillsDir,phase:'restored_verifying',originalServices:[{name:'scheduler',script:scripts.scheduler}],initialIdentity:{ecosystemHash:ecosystem?maintenance.hash(file):null}};
  return {root,env,skillsDir,scripts,file,j,pm2,
    records(next) {if(next)fs.writeFileSync(state,JSON.stringify(next));return JSON.parse(fs.readFileSync(state));},
    calls:() => fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],
    environments:() => fs.readFileSync(environments,'utf8').trim().split('\n').map(JSON.parse),
    fail:() => fs.writeFileSync(failure,'fail'),listLimit:count=>fs.writeFileSync(listLimit,String(count)),record,
    custom() {j.originalServices.push({name:'custom-service',script:scripts['custom-service']});return j;},
  };
}
