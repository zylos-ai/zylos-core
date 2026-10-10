import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const cp=require('node:child_process');
const m=require('../upgrade-maintenance.cjs');

test('cold PM2 daemon banners do not prevent recovery service discovery',t=>{
 const real=cp.spawnSync;t.after(()=>{cp.spawnSync=real;});
 const list=[{name:'activity-monitor',pid:123,pm2_env:{status:'online',pm_exec_path:'/fixture/skills/activity-monitor/monitor.js'}}];
 cp.spawnSync=()=>({status:0,stdout:'[PM2] Spawning PM2 daemon...\n[PM2] Successfully daemonized\n'+JSON.stringify(list),stderr:''});
 assert.equal(m.services({skillsDir:'/fixture/skills'})[0].name,'activity-monitor');
 cp.spawnSync=()=>({status:0,stdout:'[PM2] Spawning PM2 daemon...\n[]\n',stderr:''});
 assert.deepEqual(m.services({skillsDir:'/fixture/skills'}),[]);
 cp.spawnSync=()=>({status:0,stdout:'[PM2] daemon failed',stderr:''});
 assert.throws(()=>m.services({skillsDir:'/fixture/skills'}),/invalid PM2 list/);
});

test('stopped original PM2 records are restarted and saved only after online verification',t=>{
 const real=cp.spawnSync;t.after(()=>{cp.spawnSync=real;});
 const script='/fixture/skills/activity-monitor/monitor.js';const calls=[];let status='stopped';
 cp.spawnSync=(_bin,args)=>{
  calls.push(args);
  if(args[0]==='restart')status='online';
  return {status:0,stderr:'',stdout:args[0]==='jlist'?JSON.stringify([{name:'activity-monitor',pid:status==='online'?123:0,pm2_env:{status,pm_exec_path:script}}]):''};
 };
 const j={zylosDir:'/fixture',skillsDir:'/fixture/skills',initialIdentity:{ecosystemHash:null},originalServices:[{name:'activity-monitor',script}]};
 m.start(j);assert.ok(calls.some(a=>a[0]==='restart'));assert.ok(!calls.some(a=>a[0]==='save'));
 m.verifyServices(j);assert.deepEqual(calls.at(-1),['save']);
});
