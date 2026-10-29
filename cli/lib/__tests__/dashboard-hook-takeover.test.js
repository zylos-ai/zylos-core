import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyDashboardHooks } from '../../../skills/dashboard/test/fixtures/legacy-hooks.js';
import { prepareUpgradeRuntime } from '../upgrade-runtime-preparation.js';
import { preparePostCutoff, publishPostCutoff, removeLegacyDashboardHooks } from '../upgrade-post-cutoff.js';
const packageRoot=path.resolve(import.meta.dirname,'../../..');
function fixture(t,runtime,statusLine) {
 const homeDir=fs.realpathSync(os.homedir());
 assert.ok(homeDir.includes('zylos-tests-'), 'official isolated runner HOME required');
 // Keep the real writer's HOME and the captured path identical across macOS /var aliases.
 const originalHome=process.env.HOME;
 process.env.HOME=homeDir;
 t.after(()=>{process.env.HOME=originalHome;});
 const fixtureDir=fs.mkdtempSync(path.join(homeDir,'dashboard-hook-takeover-'));
 const zylosDir=path.join(fixtureDir,'zylos');
 const write=(relative,bytes)=>{const file=path.join(zylosDir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
 const source=legacyDashboardHooks(zylosDir);
 if(statusLine)source.claude.statusLine=statusLine;
 write('ZYLOS.md','user data');write('CLAUDE.md','old Claude');write('AGENTS.md','old Codex');
 write('.zylos/config.json',JSON.stringify({runtime}));
 write('.zylos/instructions/meta.json','{"schemaVersion":1,"activatedAt":"old"}');
 write('.claude/settings.json',JSON.stringify(source.claude));
 write('.codex/hooks.json',JSON.stringify(source.codex));
 write('.codex/config.toml','');
 fs.mkdirSync(path.join(homeDir,'.codex'),{recursive:true});fs.writeFileSync(path.join(homeDir,'.codex/config.toml'),'');
 t.after(()=>fs.rmSync(fixtureDir,{recursive:true,force:true}));
 return {homeDir,fixtureDir,zylosDir,source};
}
function userHooks(settings,source) {
 for(const [event,groups] of Object.entries(source.hooks)) {
  const kept=(settings.hooks[event] || []).flatMap(g=>g.hooks || []).filter(h=>h.command==='node /third-party/dashboard-audit.js');
  assert.deepEqual(kept,groups.flatMap(g=>g.hooks).filter(h=>h.command==='node /third-party/dashboard-audit.js'));
 }
 assert.equal(JSON.stringify(settings.hooks).includes('dashboard/src/lib/hook-ingest.cjs'),false);
}
for(const runtime of ['claude','codex']) for(const statusLineKind of ['custom','legacy']) test(`${runtime} takeover preserves mixed hooks and installs Core statusLine over ${statusLineKind} through preparation/publication`,async t=>{
 const custom={type:'command',command:'node /custom/statusline.js',refreshInterval:17};
 const f=fixture(t,runtime,statusLineKind==='custom' ? custom : undefined);
 const expected=JSON.parse(fs.readFileSync(path.join(packageRoot,'templates/.claude/settings.json'),'utf8')).statusLine;
 let firstActivityHooks;
 for(let round=0;round<2;round++){
  const prepared=prepareUpgradeRuntime({zylosDir:f.zylosDir,tempDir:packageRoot,homeDir:f.homeDir},{stopFailureSupported:false});
  const staged=JSON.parse(prepared.replacements.find(r=>r.kind==='claude_settings').content);
  userHooks(staged,f.source.claude);
  assert.deepEqual(staged.statusLine,expected);
  const transactionDir=path.join(f.fixtureDir,'transaction-'+round);fs.mkdirSync(transactionDir);
  const postCutoff=preparePostCutoff({...prepared,transactionDir,zylosDir:f.zylosDir,homeDir:f.homeDir,runtime});
  const transactionId='hook-takeover-'+round,snapshotManifestHash='a'.repeat(64);
  const journal={transactionId,zylosDir:f.zylosDir,phase:'compensation_closed',snapshotManifestHash,postCutoff,
   compensationCutoff:{formatVersion:1,closed:true,transactionId,snapshotManifestHash,writer:'finalizer',closedAt:new Date().toISOString()}};
  const ctx={zylosDir:f.zylosDir,transactionDir,transactionId,journal};
  const result=await publishPostCutoff(ctx);
  assert.equal(result.ok,true,JSON.stringify(result));
  const repeated=await publishPostCutoff(ctx);
  assert.equal(repeated.ok,true,JSON.stringify(repeated));
  assert.deepEqual(repeated.writtenTargets,[],'completed publication must not write hooks again');
  const installed=JSON.parse(fs.readFileSync(path.join(f.zylosDir,'.claude/settings.json')));
  userHooks(installed,f.source.claude);assert.deepEqual(installed.statusLine,expected);
  const codex=JSON.parse(fs.readFileSync(path.join(f.zylosDir,'.codex/hooks.json')));userHooks(codex,f.source.codex);
  const activityHooks = Object.fromEntries(Object.entries({claude:installed.hooks,codex:codex.hooks}).map(([name,events])=>[name,Object.fromEntries(Object.entries(events).map(([event,groups])=>[event,groups.flatMap(group=>(group.hooks || []).filter(hook=>hook.command.includes('activity-monitor/')))]))]));
  assert.ok(Object.values(activityHooks.claude).some(hooks=>hooks.length), 'Core activity hooks must be installed');
  if(round===0)firstActivityHooks=structuredClone(activityHooks);else assert.deepEqual(activityHooks,firstActivityHooks,'repeated publication must not duplicate Core activity hooks');
 }
});

test('exact legacy hook removal preserves third-party hooks',t=>{
 const f=fixture(t,'claude');
 const cleaned=removeLegacyDashboardHooks(f.source.claude,f.zylosDir);userHooks(cleaned,f.source.claude);
});
