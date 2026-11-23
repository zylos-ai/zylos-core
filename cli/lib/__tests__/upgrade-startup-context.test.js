import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {discoverUpgradeContext} from '../runtime/upgrade-context.js';
const maintenance = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function publishedTransaction(t, {fail = false, controller = false, failure} = {}) {
 const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-startup-published-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir = path.join(root,'.backup/self-upgrade/tx');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const executed = path.join(root,'recovery-executed');
 for (const [source,name] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-installer.cjs','installer.cjs'],['upgrade-bootstrap.cjs','bootstrap.cjs'],['upgrade-recovery.cjs','recovery.cjs']]) fs.copyFileSync(path.resolve('cli/lib',source),path.join(dir,name));
 fs.writeFileSync(path.join(dir,'runner.cjs'),`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(executed)},JSON.stringify(process.argv.slice(2)));${failure ? `console.log(${JSON.stringify(JSON.stringify(failure))});process.exit(1);` : fail?'process.exit(9);':`fs.rmSync(${JSON.stringify(dir)},{recursive:true});console.log(JSON.stringify({recovery_required:false,stage:'aborted_before_install'}));`}`);
 const journal={formatVersion:1,transactionId:'tx',zylosDir:root,nodePath:process.execPath,from:'0.9.3',phase:'preparing',installationIntent:false,initialIdentity:{},recoveryHashes:Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs'].map(name=>[name,maintenance.hash(path.join(dir,name))]))};
 if(controller){
  const digest='a'.repeat(64);
  Object.assign(journal,{phase:'restored_data_ready',installationIntent:true,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db/tx'),snapshotManifestHash:digest,
   coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:digest}],originalServices:[],
   initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:digest,cliRoot:path.join(root,'cli'),cliHash:digest,workerPath:path.join(root,'cli/worker.js'),workerHash:digest,ecosystemHash:null,databases:maintenance.databasePaths(2).map(source=>({source,exists:true}))}});
 }
 maintenance.update(dir,journal);
 if(controller)maintenance.durable(path.join(dir,'controller.json'),maintenance.identity());
 return {root,dir,journal,executed};
}

test('failed startup recovery preserves history and returns the recovery prompt', {skip:process.platform!=='linux'}, t => {
 t.mock.method(maintenance,'canRecognizeProcesses',()=>true);
 const f=publishedTransaction(t,{fail:true});
 const context=discoverUpgradeContext(f.root);
 assert.equal(context.active,true);assert.equal(context.blocked,true);assert.equal(context.recovery_required,true);
 assert.match(context.prompt,/SYSTEM RECOVERY TASK/);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.executed,'utf8')),['resume','--transaction-dir',f.dir]);
 assert.equal(fs.existsSync(f.dir),true);
});


test('completed historical transactions with retained recovery files leave ordinary startup untouched', t => {
 const f=publishedTransaction(t),digest='a'.repeat(64);
 Object.assign(f.journal,{phase:'aborted_before_install',skillsDir:path.join(f.root,'.claude/skills'),
  coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:digest}],originalServices:[],
  initialIdentity:{nodePath:process.execPath,packageJson:path.join(f.root,'package.json'),packageHash:digest,cliRoot:path.join(f.root,'cli'),cliHash:digest,workerPath:path.join(f.root,'cli/worker.js'),workerHash:digest,ecosystemHash:null,databases:maintenance.databasePaths(2).map(source=>({source,exists:true}))},
  cleanup:{complete:true,servicesRestored:true},terminalEvidence:{verified:true,kind:'original_deployment_and_readonly_data'}});
 maintenance.update(f.dir,f.journal);
 assert.equal(maintenance.terminalValid(f.journal),true);
 assert.deepEqual(discoverUpgradeContext(f.root),{active:false,blocked:false});
 assert.equal(fs.existsSync(f.executed),false);
});

test('startup rejects modified transaction recovery and unrecognizable ownership without executing code', {skip:process.platform!=='linux'}, t => {
 t.mock.method(maintenance,'canRecognizeProcesses',()=>true);
 for(const attack of ['modified-runner','unknown-process']) {
  const f=publishedTransaction(t),recognize=maintenance.canRecognizeProcesses;
  if(attack==='modified-runner')fs.appendFileSync(path.join(f.dir,'runner.cjs'),'\n// changed');
  else {
   const hash='a'.repeat(64);
   Object.assign(f.journal,{phase:'compensation_closed',snapshotManifestHash:hash,
    compensationCutoff:{formatVersion:1,closed:true,transactionId:'tx',snapshotManifestHash:hash,closedAt:'2026-10-27T00:00:00.000Z',writer:'finalizer'},
    postCutoff:{formatVersion:1,items:{hooks:{state:'pending',attempts:0,lastError:null}}},dashboardInstall:null});
   maintenance.update(f.dir,f.journal);
   maintenance.canRecognizeProcesses=()=>false;
  }
  let context;
  try{context=discoverUpgradeContext(f.root);}finally{maintenance.canRecognizeProcesses=recognize;}
  assert.equal(context.recovery_required,true);
  assert.equal(context.blocked,true);
  if(attack==='unknown-process')assert.doesNotMatch(context.prompt,/zylos upgrade --resume-finalize/);
  assert.equal(fs.existsSync(f.executed),false);
 }
});

test('C4 delivered-tail hook reads normal context after READY but isolates blocked recovery', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-c4-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stable = path.join(root, '.zylos/upgrade');
  const scripts = path.join(root, 'skills/comm-bridge/scripts');
  const registry = path.join(root, 'skills/activity-monitor/scripts');
  for (const dir of [stable, scripts, registry]) fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(stable, 0o700);
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode: 0o600});
  for (const file of ['maintenance.cjs']) fs.writeFileSync(path.join(stable, file), '// fixture dependency\n', {mode: 0o600});
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/c4-session-init.js'), path.join(scripts, 'c4-session-init.js'));
  fs.writeFileSync(path.join(scripts, 'c4-diagnostic.js'), 'export function logHookTiming() {}\n');
  fs.writeFileSync(path.join(scripts, 'session-format.js'), 'export const formatSection = (label, text) => label + ": " + text;\n');
  fs.writeFileSync(path.join(registry, 'shard-registry.js'), 'export const withinBudget = () => true;\n');
  fs.writeFileSync(path.join(registry, 'bootstrap-identity.js'), 'export const isSubsession = () => false;\n');
  fs.writeFileSync(path.join(registry, 'bootstrap-scope.js'), `export const bootstrapScope = () => ({mode:'single',scope:'*',root:${JSON.stringify(root)},memoryDir:${JSON.stringify(path.join(root, 'memory'))}});\n`);
  fs.writeFileSync(path.join(scripts, 'c4-db.js'), 'export const getGlobalCoverageEnd = () => 0; export const getGlobalDeliveredSince = () => [{content: "ordinary delivered message"}]; export const formatConversationsForAgent = rows => rows.map(row => row.content).join("\\n"); export function close() {}\n');
  for (const blocked of [false, true]) {
    fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `exports.bootstrap = () => ({active: true, blocked: ${blocked}, prompt: 'isolated recovery'});\n`);
    fs.chmodSync(path.join(stable, 'bootstrap.cjs'), 0o600);
    const runner = path.join(root, 'runner.js');
    fs.writeFileSync(runner, 'import {emitC4Conversations} from "./skills/comm-bridge/scripts/c4-session-init.js"; console.log(await emitC4Conversations());\n');
    const result = spawnSync(process.execPath, [runner], {encoding: 'utf8', env: {ZYLOS_DIR: root, PATH: process.env.PATH}});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, blocked ? /UPGRADE RECOVERY TASK/ : /ordinary delivered message/);
    if (blocked) assert.doesNotMatch(result.stdout, /ordinary delivered message|Working memory/);
    else assert.match(result.stdout, /UPGRADE RECOVERY TASK/);
  }
});

function stableFixture(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-trusted-context-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode: 0o600});
  for (const file of ['maintenance.cjs']) {
    fs.writeFileSync(path.join(stable, file), '// fixture dependency\n', {mode: 0o600});
  }
  const entry = path.join(stable, 'bootstrap.cjs');
  fs.writeFileSync(entry, body, {mode: 0o600});
  return {root, stable, entry};
}

test('direct delivered-tail export receives recovery before scope loading despite a stale runtime flag', t => {
  const f = stableFixture(t, 'exports.bootstrap = () => {throw Error("discovery unavailable");};\n');
  const scripts = path.join(f.root, 'hook');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/c4-session-init.js'), path.join(scripts, 'c4-session-init.js'));
  const runner = path.join(f.root, 'runner.js');
  fs.writeFileSync(runner, 'import {emitC4Conversations} from "./hook/c4-session-init.js"; console.log(await emitC4Conversations(undefined, null, {scopeReader: () => {throw Error("scope must not load during recovery");}}));\n');
  for (const delivered of [false, true]) {
    const result = spawnSync(process.execPath, [runner], {encoding: 'utf8', env: {
      ZYLOS_DIR: f.root, PATH: process.env.PATH,
      ...(delivered ? {ZYLOS_UPGRADE_PROMPT_DELIVERED: '1'} : {}),
    }});
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/SYSTEM RECOVERY TASK/g) || []).length, 1);
  }
});
