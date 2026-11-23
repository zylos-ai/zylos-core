import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collectHealthHook} from '../hook-health.js';
function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-hook-stream-'));
  t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  return {zylosDir,pid:process.pid};
}
const payload={hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit'};
test('collector appends bounded structured evidence without private prompt or error text',async t=>{
  const options=fixture(t);
  const event=await collectHealthHook({...payload,prompt:'PRIVATE',error_details:'You have hit your usage limit PRIVATE'},options);
  assert.equal(event.v,1);assert.equal(event.session_group,null);assert.equal(event.run_id,null);
  assert.equal(event.event,'stop_failure');assert.equal(event.type,'runtime_health');assert.equal(event.claude_pid,process.pid);
  const raw=fs.readFileSync(path.join(options.zylosDir,'activity-monitor/events.jsonl'),'utf8');
  assert.doesNotMatch(raw,/PRIVATE|runtime_generation/);assert.equal(JSON.parse(raw).event_id,event.event_id);
  assert.equal(fs.existsSync(path.join(options.zylosDir,'activity-monitor/health-inbox')),false);
});
test('CLI collector fails open for malformed input without echoing sensitive text',t=>{
  const options=fixture(t);const script=fileURLToPath(new URL('../hook-health.js',import.meta.url));
  const result=spawnSync(process.execPath,[script],{input:'PRIVATE invalid json',encoding:'utf8',env:{...process.env,ZYLOS_DIR:options.zylosDir}});
  assert.equal(result.status,0);assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE/);
  assert.match(result.stderr,/could not be persisted/);
});

