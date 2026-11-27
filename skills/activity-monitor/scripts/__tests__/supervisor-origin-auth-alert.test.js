import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PENDING_MAX_AGE_SECONDS } from '../../../comm-bridge/scripts/c4-config.js';
import { startSupervisor } from '../supervisor-main.js';

// Real entry -> Origin demand/health -> owner alert text. Run for entry alert
// formatting or wiring; skip unrelated lifecycle work. The runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR. Private am.sock, injected
// scenes/database/sender; no live tmux/PM2/network. Stop before owned-file cleanup.
test('Origin authentication expiry sends the bilingual owner alert with the runtime and local time', {timeout:5000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'origin-alert-entry-'));
  const oldestAt=1795226404, now=(oldestAt+PENDING_MAX_AGE_SECONDS-300)*1000, messages=[];
  let service;
  t.after(async()=>{try{await service?.stop();}finally{fs.rmSync(root,{recursive:true,force:true});}});
  const db={getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,
    listPendingSessionGroups:()=>[],listPendingContinuations:()=>[],listRunEndings:()=>[],
    listSlotOccupancy:()=>[],pruneSlots:()=>({deletedHeld:0,deletedOrphans:[]}),
    getLastCompletedModeTransition:()=>null,getControlById:()=>null,
    getOriginNeed:()=>({inbound:{count:1,oldestAt},controls:{count:0,oldestAt:null}}),
    resolveSessionLaunchConfig:()=>({runtime:'claude',mode:'default'})};
  const scenes={observe:async()=>[],readIdentity:async()=>({present:false}),
    observeGroup:async()=>({present:false}),listRuns:async()=>[],readRun:async()=>null};
  service=await startSupervisor({env:{...process.env,HOME:root,ZYLOS_DIR:root,PM2_HOME:path.join(root,'.pm2')},
    db,scenes,now:()=>now,readMode:()=>({mode:'multi',keyPresent:true}),
    readConfig:()=>({session_mode:'multi',runtime:'claude',session_pool_size:2,statusNotices:{timeZone:'Asia/Singapore'}}),
    readMemoryInputs:async()=>({source:'host',limitBytes:8*1024**3,usedBytes:2*1024**3}),
    legacyStatus:{tick(){},close(){}},machineTasks:{tick(){},stop(){}},
    sendAlert:async(target,message)=>{messages.push({target,message});return true;},
    log:()=>{},loopOptions:{schedule:()=>1,cancel(){}}});
  const store=service.supervisor.health.store('claude'),health=store.read();
  health.health='auth_failed';health.reason='authentication_failed';store.write(health);
  await service.supervisor.loop.tick();
  assert.equal(messages.length,1);
  assert.deepEqual(messages[0].target,{channel:'dashboard',endpoint:'origin'});
  assert.equal(messages[0].message, [
    '[Zylos] Claude 登录失效，Origin 从 2026-11-21 10:00 Asia/Singapore 起有消息还没处理。系统在自动重试，登录恢复后会接着处理；如果一直不恢复，请检查 Claude 的登录。',
    '[Zylos] Claude sign-in has failed, and Origin has had unprocessed messages since 2026-11-21 10:00 Asia/Singapore. The system keeps retrying and will continue once sign-in is restored. If it does not recover, check the Claude login.',
  ].join('\n'));
});

