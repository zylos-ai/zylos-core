import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {savePm2ProcessList} from '../pm2-save.js';
import {discoverUpgradeContext} from '../runtime/upgrade-context.js';
import {runSelfUpgrade} from '../self-upgrade.js';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-daily-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
 for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-bootstrap.cjs','bootstrap.cjs']]) {
  fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dest));fs.chmodSync(path.join(stable,dest),0o600);
 }
 const dir=path.join(root,'.backup/self-upgrade/active');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const digest='a'.repeat(64);
 const j={formatVersion:1,transactionId:'active',zylosDir:root,phase:'new_data_ready',installationIntent:true,
  nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db/active'),snapshotManifestHash:digest,
  coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:digest}],originalServices:[],
  initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:digest,cliRoot:path.join(root,'cli'),cliHash:digest,
   workerPath:path.join(root,'cli/worker.js'),workerHash:digest,ecosystemHash:null,databases:m.DB_PATHS.map(source=>({source,exists:true}))}};
 function save(){m.durable(path.join(dir,'journal.json'),j);}
 save();return {root,dir,stable,j,save};
}
function writeUsingOwners(root) {
 const code=`import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';import {openDb} from './skills/web-console/scripts/db.js';for(const db of [getDb(),scheduler(),openDb()]){db.exec('CREATE TABLE IF NOT EXISTS daily_probe(value TEXT)');db.prepare('INSERT INTO daily_probe VALUES (?)').run('written');}close();`;
 return spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:root}});
}
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
  assert.equal(hook.status,0,hook.stderr);assert.match(hook.stdout,/LAST CHECKPOINT/);assert.doesNotMatch(hook.stdout,/UPGRADE RECOVERY TASK/);
 }
 assert.equal(m.discover(f.root).blocked,true,'explicit recovery still diagnoses damaged history');
});

test('active READY ignores unrelated corrupt history, allows real writes, and still suppresses PM2 save',t=>{
 const f=fixture(t);m.marker(f.root,f.dir,f.j);
 const old=path.join(f.root,'.backup/self-upgrade/old');fs.mkdirSync(old,{mode:0o700});fs.writeFileSync(path.join(old,'journal.json'),'{');
 assert.equal(m.discover(f.root).blocked,true);
 assert.equal(m.discoverActive(f.root).blocked,false);
 assert.equal(discoverUpgradeContext(f.root).blocked,false);
 assert.equal(savePm2ProcessList({root:f.root,save:()=>assert.fail('must preserve list'),log:()=>{}}),false);
 const result=writeUsingOwners(f.root);assert.equal(result.status,0,result.stderr);
});

for(const phase of ['preparing','stopping','offline','installing','restoring','recovery_required'])test(`explicit active ${phase} prevents actual owner writes`,t=>{
 const f=fixture(t);f.j.phase=phase;f.save();m.marker(f.root,f.dir,f.j);
 assert.equal(m.discoverActive(f.root).blocked,true);
 const result=writeUsingOwners(f.root);assert.notEqual(result.status,0);assert.match(result.stderr,/maintenance/);
 for(const source of m.DB_PATHS)assert.equal(fs.existsSync(path.join(f.root,source)),false);
});

test('malformed active journal stays blocked while abandoned unmarked preparation permits daily use but rejects upgrade',t=>{
 const f=fixture(t);f.j.phase='preparing';f.j.installationIntent=false;f.save();
 assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(f.root));
 let preflight=false;
 const result=runSelfUpgrade({newVersion:'fixture'},{zylosDir:f.root,protectionSupported:()=>true,getCurrentVersion:()=>({success:true,version:'old'}),preflightCoreDbUpgrade:()=>{preflight=true;}});
 assert.equal(result.success,false);assert.equal(result.recovery_required,true);assert.equal(preflight,false);
 m.marker(f.root,f.dir,f.j);fs.writeFileSync(path.join(f.dir,'journal.json'),'{');
 assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),/maintenance/);assert.equal(discoverUpgradeContext(f.root).blocked,true);
});
