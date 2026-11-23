import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UsageMonitor } from '../usage-monitor.js';
function fixture(t,runtime='claude') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-monitor-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls={control:[],samples:[]};let limits={five_hour:{used_percentage:20},seven_day:{used_percentage:45}};
  const monitor=new UsageMonitor({runtimeId:runtime},{zylosDir:dir,usageStateFile:path.join(dir,'usage.json'),usageAlertStateFile:path.join(dir,'alert.json'),
    monitorEnabled:true,alertEnabled:true,warnThreshold:80,highThreshold:90,criticalThreshold:95,notifyCooldownSec:14400,
    readMode:()=>({mode:'multi'}),readAccountUsage:async r=>{calls.samples.push(r);return limits;},runC4Control:args=>{calls.control.push(args);return {ok:true,output:'control 1'};},log:()=>{}});
  return {dir,monitor,calls,setLimits:value=>limits=value};
}
test('usage alert samples current account and targets Origin with preserved delivery options',async t=>{
  const f=fixture(t,'codex');f.setLimits({sevenDay:{usedPercentage:96,resetsAt:2000},fiveHour:{usedPercentage:70}});
  assert.equal(await f.monitor.runAlert({currentTime:2000}),true);
  assert.deepEqual(f.calls.samples,['codex']);assert.equal(f.calls.control.length,1);
  const args=f.calls.control[0];assert.match(args[2],/Usage Critical/);assert.deepEqual(args.slice(-2),['--group','origin']);
  assert.ok(args.includes('--no-ack-suffix'));assert.ok(args.includes('--available-in'));
  const state=JSON.parse(fs.readFileSync(path.join(f.dir,'alert.json')));assert.equal(state.sourceRuntime,'codex');assert.equal(state.lastNotifiedAt,new Date(2000000).toISOString());
});
