import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionReader } from '../session-state-reader-async.js';
import { prepareUpgradeRuntime } from '../upgrade-runtime-preparation.js';
import { activateFreshSplitInstructions } from '../runtime/instruction-builder.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'activity-monitor/session-groups/origin');fs.mkdirSync(dir,{recursive:true});
  const identity={present:true,ready:true,runtime:'agy',runId:'run',sessionId:'session',createdAt:1,serverGeneration:'1:1',tmuxSessionId:'$1',paneId:'%1',launchConfig:{runtime:'agy',mode:'default'}};
  fs.writeFileSync(path.join(dir,'statusline.json'),JSON.stringify({session_id:'session',context_window:{used_percentage:37,context_window_size:1048576},zylos:{v:1,runId:'run',capturedAt:1000}}));
  return {root,dir,identity};
}
test('single and batched AGY state readers use identity-bound statusLine context',async t=>{
  const {root,dir,identity}=fixture(t);let closes=0;
  const reader=createSessionReader({env:{ZYLOS_DIR:root},now:()=>1100,open:async()=>({close:()=>closes++}),observe:async()=>identity,observeAll:async()=>new Map([['origin',identity]])});
  const single=await reader.readSessionState(null,{freshnessMs:1000});
  assert.equal(single.usage.valid,true);assert.equal(single.usage.value.context_window.used_percentage,37);
  const batch=await reader.readSessionStates(['origin'],{freshnessMs:1000});assert.equal(batch.get('origin').usage.valid,true);
  fs.writeFileSync(path.join(dir,'statusline.json'),JSON.stringify({session_id:'other',zylos:{v:1,runId:'run',capturedAt:1000}}));
  assert.equal((await reader.readSessionState(null,{freshnessMs:1000})).usage.reason,'identity_mismatch');
  assert.equal(closes,3);
});
test('upgrade preparation renders the same complete AGENTS for agy and Codex', t => {
  const { root } = fixture(t);
  activateFreshSplitInstructions({ zylosDir: root });
  fs.appendFileSync(path.join(root, 'ZYLOS.md'), 'shared user rule '.repeat(3000) + '\nUPGRADE_USER_TAIL');
  const config = path.join(root, '.zylos/config.json');
  const options = { stopFailureSupported: false, subagentHooksSupported: false,
    generatedAt: new Date('2026-01-01T00:00:00Z') };
  const outputs = [];
  for (const runtime of ['agy', 'codex']) {
    fs.writeFileSync(config, JSON.stringify({ runtime }));
    const result = prepareUpgradeRuntime({ zylosDir: root }, options);
    const agents = result.replacements.find(item => item.path === 'AGENTS.md');
    assert.ok(agents.content.includes('UPGRADE_USER_TAIL'));
    assert.ok(agents.content.startsWith('<!-- zylos-generated:split-v1'));
    outputs.push(Buffer.from(agents.content));
  }
  assert.ok(outputs[0].equals(outputs[1]), 'upgrade instruction bytes must not depend on runtime');
});

test('AGY single and batch readers retain change-driven samples beyond seventy seconds', async t => {
  const {root,dir,identity}=fixture(t);
  const reader=createSessionReader({env:{ZYLOS_DIR:root},now:()=>72000,
    open:async()=>({close:async()=>{}}),observe:async()=>identity,observeAll:async()=>new Map([['origin',identity]])});
  const status=path.join(dir,'agent-status.json');
  fs.writeFileSync(status,JSON.stringify({runId:'run',sessionId:'session',state:'idle'}));fs.utimesSync(status,1,1);
  for(const agent_state of ['idle','working']) {
    fs.writeFileSync(path.join(dir,'statusline.json'),JSON.stringify({session_id:'session',agent_state,
      zylos:{v:1,runId:'run',capturedAt:1000}}));
    const single=await reader.readSessionState(null,{freshnessMs:1000,usageFreshnessMs:1});
    const batch=(await reader.readSessionStates(['origin'],{freshnessMs:1000,usageFreshnessMs:1})).get('origin');
    for(const result of [single,batch]) {
      assert.equal(result.usage.valid,true);assert.equal(result.usage.value.agent_state,agent_state);
      assert.equal(result.usage.sampledAt,1000);assert.equal(result.status.reason,'stale');
    }
  }
});

test('AGY no-expiry reader keeps run, session, version and live identity fences', async t => {
  const {root,dir,identity}=fixture(t);
  const read=async(sample,last=identity)=>{
    fs.writeFileSync(path.join(dir,'statusline.json'),JSON.stringify(sample));
    let singleCalls=0,batchCalls=0;
    const reader=createSessionReader({env:{ZYLOS_DIR:root},now:()=>72000,open:async()=>({close:async()=>{}}),
      observe:async()=>++singleCalls===1?identity:last,
      observeAll:async()=>new Map([['origin',++batchCalls===1?identity:last]])});
    return [(await reader.readSessionState(null,{freshnessMs:1000})).usage,
      (await reader.readSessionStates(['origin'],{freshnessMs:1000})).get('origin').usage];
  };
  const base={session_id:'session',agent_state:'idle',zylos:{v:1,runId:'run',capturedAt:1000}};
  for(const [sample,last,reason] of [
    [{...base,session_id:'other'},identity,'identity_mismatch'],
    [{...base,zylos:{...base.zylos,runId:'other'}},identity,'identity_mismatch'],
    [{...base,zylos:{...base.zylos,v:2}},identity,'version_unknown'],
    [{...base,zylos:{v:1,runId:'run'}},identity,'stale'],
    [base,{...identity,sessionId:'replacement'},'identity_changed'],
    [base,{...identity,present:false,ready:false},'identity_changed'],
  ]) for(const result of await read(sample,last)) {
    assert.equal(result.valid,false);assert.equal(result.reason,reason);
  }
});
