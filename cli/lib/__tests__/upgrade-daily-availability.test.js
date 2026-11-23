import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {savePm2ProcessList} from '../pm2-save.js';
import {discoverUpgradeContext} from '../runtime/upgrade-context.js';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.UPGRADE_DAILY_TEST_TMPDIR || os.tmpdir(),'upgrade-daily-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
 for(const [src,dest] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-bootstrap.cjs','bootstrap.cjs']]) {
  fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dest));fs.chmodSync(path.join(stable,dest),0o600);
 }
 const dir=path.join(root,'.backup/self-upgrade/active');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const digest='a'.repeat(64);
 const j={formatVersion:1,transactionId:'active',zylosDir:root,phase:'restored_data_ready',installationIntent:true,
  nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db/active'),snapshotManifestHash:digest,
  coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:digest}],originalServices:[],
  initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:digest,cliRoot:path.join(root,'cli'),cliHash:digest,
   workerPath:path.join(root,'cli/worker.js'),workerHash:digest,ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:true}))}};
 function save(){m.durable(path.join(dir,'journal.json'),j);}
 save();return {root,dir,stable,j,save};
}
function writeUsingOwners(root) {
 const code=`import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';for(const db of [getDb(),scheduler()]){db.exec('CREATE TABLE IF NOT EXISTS daily_probe(value TEXT)');db.prepare('INSERT INTO daily_probe VALUES (?)').run('written');}close();`;
 return spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:root}});
}
for (const phase of ['upgrade_complete','restored_complete','aborted_before_install']) test(`completed legacy three-database ${phase} history permits upgrade admission`, t => {
 const f=fixture(t);
 f.j.phase=phase;
 f.j.initialIdentity.databases.pop();
 f.j.installationIntent=phase!=='aborted_before_install';
 f.j.cleanup={complete:true,servicesRestored:true};
 f.j.terminalEvidence={verified:true,kind:f.j.installationIntent?'code_data_services':'original_deployment_and_readonly_data'};
 f.save();
 assert.deepEqual(m.discover(f.root),{marker:null,candidates:[],diagnostics:[],blocked:false});
 for (const corrupt of [...(phase==='upgrade_complete'?[]:[j=>{j.cleanup.complete=false;}]),j=>{j.phase='installing';},j=>{j.terminalEvidence.verified=false;},j=>{j.recoveryHashes={};},j=>{j.compensationCutoff={};}]) {
  const saved=structuredClone(f.j);corrupt(f.j);f.save();
  assert.equal(m.discover(f.root).blocked,true);
  Object.assign(f.j,saved);delete f.j.recoveryHashes;delete f.j.compensationCutoff;
 }
});



for(const damage of ['malformed','missing','oversized','unknown-entry','dangling-backup'])test(`unmarked ${damage} history cannot stop ordinary database writes or startup`,t=>{
 const f=fixture(t);
 if(damage==='malformed')fs.writeFileSync(path.join(f.dir,'journal.json'),'{');
 if(damage==='missing')fs.unlinkSync(path.join(f.dir,'journal.json'));
 if(damage==='oversized')fs.writeFileSync(path.join(f.dir,'journal.json'),'x'.repeat(1024*1024+1));
 if(damage==='unknown-entry')fs.writeFileSync(path.join(f.root,'.backup/self-upgrade/foreign-entry'),'anything');
 if(damage==='dangling-backup'){fs.renameSync(path.join(f.root,'.backup'),path.join(f.root,'old-backup'));fs.symlinkSync(path.join(f.root,'absent'),path.join(f.root,'.backup'));}
 assert.equal(discoverUpgradeContext(f.root).active,false);
 assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(f.root));
 assert.equal(savePm2ProcessList({root:f.root,save:()=>{},log:()=>{}}),true);
 const result=writeUsingOwners(f.root);assert.equal(result.status,0,result.stderr);
 if(damage==='malformed') {
  const hook=spawnSync(process.execPath,['skills/comm-bridge/scripts/c4-session-init.js'],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:f.root}});
  assert.equal(hook.status,0,hook.stderr);
  assert.match(hook.stdout,/^=== RECENT CONVERSATIONS ===$/m);
  assert.ok(hook.stdout.includes(`Scope: *. Working memory is not injected. Read the complete snapshot with: node ${path.join(f.root,'.claude/skills/zylos-memory/scripts/read-work-memory.js')} --json`));
  assert.ok(hook.stdout.includes(`No handoff file is available for this scope (${path.join(f.root,'memory/handoff.md')}).`));
  assert.doesNotMatch(hook.stdout,/Before resuming work, read .*handoff/);
  assert.doesNotMatch(hook.stdout,/LAST CHECKPOINT|UPGRADE RECOVERY TASK/);
 }
 assert.equal(m.discover(f.root).blocked,true,'explicit recovery still diagnoses damaged history');
});

for(const phase of ['preparing','stopping','offline','installing','restoring','recovery_required'])test(`explicit active ${phase} prevents actual owner writes`,t=>{
 const f=fixture(t);f.j.phase=phase;f.save();m.marker(f.root,f.dir,f.j);
 assert.equal(m.discoverActive(f.root).blocked,true);
 const result=writeUsingOwners(f.root);assert.notEqual(result.status,0);assert.match(result.stderr,/maintenance/);
 for(const source of m.DB_PATHS)assert.equal(fs.existsSync(path.join(f.root,source)),false);
});
