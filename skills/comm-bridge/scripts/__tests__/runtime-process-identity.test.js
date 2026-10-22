import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDeliveryIdentity } from '../runtime-delivery.js';
const foreground={session_id:'managed-session',claude_pid:103};
function fixture({record=foreground,pane=101,parents={103:102,102:101},platform='linux',procFails=false}={}) {
  let procReads=0,psReads=0;
  const options={zylosDir:'/isolated',session:'managed',platform,
    run:(bin,args)=>{
      if(bin==='tmux'){assert.ok(args.includes('managed'));return String(pane);}
      assert.equal(bin,'ps');psReads++;return String(parents[Number(args.at(-1))]||1);
    },
    read:file=>{
      if(file.endsWith('foreground-session.json'))return JSON.stringify(record);
      procReads++;if(platform!=='linux'||procFails)throw new Error('no procfs');
      const pid=Number(file.match(/\/proc\/(\d+)\/stat/)[1]);
      return `${pid} (process with spaces) S ${parents[pid]||1} 0`;
    }};
  return {options,counts:()=>({procReads,psReads})};
}
test('Linux managed ancestry proves PID/session without generation or process start',()=>{
  assert.deepEqual(readDeliveryIdentity(fixture().options),{runtime:'claude',...foreground});
  assert.deepEqual(readDeliveryIdentity(fixture({pane:103}).options),{runtime:'claude',...foreground});
});
test('Darwin verifies pane ancestry using ps and never reads procfs',()=>{
  const f=fixture({platform:'darwin'});assert.deepEqual(readDeliveryIdentity(f.options),{runtime:'claude',...foreground});
  assert.deepEqual(f.counts(),{procReads:0,psReads:2});
});
test('Linux can use ps fallback when procfs is unreadable',()=>{
  const f=fixture({procFails:true});assert.deepEqual(readDeliveryIdentity(f.options),{runtime:'claude',...foreground});assert.equal(f.counts().psReads,2);
});
test('foreign PID, missing session, invalid pane and cycles cannot establish identity',()=>{
  for(const options of [{pane:999},{pane:0},{record:{...foreground,session_id:''}},{record:{...foreground,claude_pid:'103'}},{record:{...foreground,claude_pid:0}},{parents:{103:102,102:103}}]) {
    for(const platform of ['linux','darwin'])assert.equal(readDeliveryIdentity(fixture({...options,platform}).options),null);
  }
});
test('legacy process start metadata is not a second identity authority',()=>{
  const record={...foreground,process_start:'obsolete'};
  assert.deepEqual(readDeliveryIdentity(fixture({record}).options),{runtime:'claude',...foreground});
});
