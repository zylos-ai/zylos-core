import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('statusLine child publishes samples without early Sync or rotation controls',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'statusline-control-boundary-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const scripts=path.join(root,'.claude/skills/comm-bridge/scripts');fs.mkdirSync(scripts,{recursive:true});
  fs.writeFileSync(path.join(scripts,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(scripts,'c4-control.js'),"import fs from 'node:fs';fs.appendFileSync(process.env.ZYLOS_DIR+'/control-calls','called');");
  const script=fileURLToPath(new URL('../context-monitor.js',import.meta.url));
  for(const percent of [60,75,99]) {
    const child=spawnSync(process.execPath,[script],{env:{...process.env,ZYLOS_DIR:root,ZYLOS_RUN_ID:'run',ZYLOS_SESSION_GROUP:'origin'},encoding:'utf8',input:JSON.stringify({session_id:'s',context_window:{used_percentage:percent}}),timeout:15000});
    assert.equal(child.status,0,child.stderr);
    const sample=JSON.parse(fs.readFileSync(path.join(root,'activity-monitor/session-groups/origin/statusline.json')));
    assert.equal(sample.context_window.used_percentage,percent);assert.equal(sample.zylos.runId,'run');
  }
  assert.equal(fs.existsSync(path.join(root,'control-calls')),false);
  assert.equal(fs.existsSync(path.join(root,'activity-monitor/context-monitor-state.json')),false);
});
