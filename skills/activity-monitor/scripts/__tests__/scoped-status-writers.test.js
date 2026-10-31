import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishSessionStatus } from '../status-writer.js';
import { publishContextSample } from '../context-monitor.js';
import { readJsonSample, sampleResult } from '../../../../cli/lib/session-usage-reader.js';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-writer-reader-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const env={ZYLOS_DIR:root,ZYLOS_RUN_ID:'r',ZYLOS_SESSION_GROUP:'origin'};const runDir=path.join(root,'activity-monitor/session-groups/origin');const identity={present:true,ready:true,runId:'r',sessionId:'s',runtime:'claude'};return {root,env,runDir,identity};}
// 10b/writer output is accepted by the actual sample reader only for current identity.
test('atomic writer and reader reject a foreign run and missing identity',t=>{
 const f=fixture(t),file=path.join(f.runDir,'agent-status.json');const write=scene=>publishSessionStatus({statusFile:file,scene:{...f.identity,...scene},activity:{sessionId:'s',state:'idle',lastActivityAt:1,tools:[]},health:{health:'ok'}});
 write({});const sample=readJsonSample(file,'status');assert.equal(sampleResult(sample,f.identity,f.identity,1000,Date.now()).valid,true);
 write({runId:'other'});assert.equal(sampleResult(readJsonSample(file,'status'),f.identity,f.identity,1000,Date.now()).reason,'identity_mismatch');
 const value=JSON.parse(fs.readFileSync(file));delete value.runId;fs.writeFileSync(file,JSON.stringify(value));assert.equal(sampleResult(readJsonSample(file,'status'),f.identity,f.identity,1000,Date.now()).reason,'identity_missing');
 assert.throws(()=>write({runId:null}),{code:'IDENTITY_UNAVAILABLE'});
});
test('writer preserves native payload; rejects wrong run, unknown version and stale capture',t=>{
 const f=fixture(t),now=Date.now(),raw={session_id:'s',context_window:{used_percentage:42},cost:{total_cost_usd:0.3},unknownNative:{keep:true}};
 publishContextSample(raw,{env:f.env,now});const file=path.join(f.runDir,'statusline.json');const value=JSON.parse(fs.readFileSync(file));const {zylos,...native}=value;assert.deepEqual(native,raw);assert.equal(zylos.runId,'r');
 const read=()=>sampleResult(readJsonSample(file,'usage'),f.identity,f.identity,1000,now);assert.equal(read().valid,true);
 value.zylos.runId='other';fs.writeFileSync(file,JSON.stringify(value));assert.equal(read().reason,'identity_mismatch');
 value.zylos.runId='r';value.zylos.v=999;fs.writeFileSync(file,JSON.stringify(value));assert.equal(read().reason,'version_unknown');
 value.zylos.v=1;value.zylos.capturedAt=now-1001;fs.writeFileSync(file,JSON.stringify(value));assert.equal(read().reason,'stale');
});
