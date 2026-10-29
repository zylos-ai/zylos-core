import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';
import { dashboardSchemaOwner } from '../src/lib/schema-owner.js';
import * as backup from '../../../cli/lib/core-db-backup.js';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '../../..');
const line = n => JSON.stringify({v:1,ts:n,event:`event${n}`,runtime:'claude',session_group:'origin',run_id:'r',session_id:'s'})+'\n';
const lines = (start,count) => Array.from({length:count},(_,i)=>line(start+i)).join('');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-backup-import-')));
  const file=path.join(root,'activity-monitor/session-groups/origin/events.jsonl');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const dbPath=path.join(root,'components/dashboard/dashboard.db');
  // Native dependencies are target-package dependencies; never install or touch host data.
  const dashboardRoot=path.resolve(import.meta.dirname,'..');
  const nativeModules=path.dirname(path.dirname(require.resolve('better-sqlite3/package.json')));
  for(const owner of ['comm-bridge','scheduler','web-console','dashboard']) {
    const skill=path.join(root,'.claude/skills',owner);fs.mkdirSync(skill,{recursive:true});
    fs.writeFileSync(path.join(skill,'package.json'),'{"type":"module"}');fs.symlinkSync(nativeModules,path.join(skill,'node_modules'));
  }
  const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true});
  fs.copyFileSync(path.join(repo,'cli/lib/upgrade-maintenance.cjs'),path.join(stable,'maintenance.cjs'));
  fs.copyFileSync(path.join(repo,'cli/lib/upgrade-recovery.cjs'),path.join(stable,'recovery.cjs'));
  const maintenance=require(path.join(stable,'maintenance.cjs'));
  const recovery=require(path.join(stable,'recovery.cjs'));
  let store=new Store(dbPath),importer=new CoreLogImporter({store,zylosDir:root,batchLines:200});
  t.after(async()=>{await importer.stop();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,file,dbPath,dashboardRoot,
    get store(){return store;}, get importer(){return importer;},
    async import(){await importer.importStream({stream:'events:origin',file});},
    snapshot(id){
      const result=backup.createCoreDbSnapshot({zylosDir:root,transactionId:id,fromVersion:'0.9.3',toVersion:'test-new',formatVersion:2});
      const row=result.manifest.databases.find(row=>row.owner==='dashboard'||row.source==='components/dashboard/dashboard.db');
      assert.equal(row.status,'backed_up');assert.equal(row.integrityCheck,'ok');
      const copy=path.join(result.dbBackupDir,row.file);assert.equal(sha(copy),row.sha256);
      const db=new Database(copy,{readonly:true});
      try {assert.equal(db.pragma('journal_mode',{simple:true}),'delete');assert.equal(db.pragma('integrity_check',{simple:true}),'ok');}
      finally{db.close();}
      return {...result,copy};
    },
    async restore(snapshot){
      await importer.stop();store.close(); // all writers stopped before offline restore
      const dir=path.join(root,'.backup/self-upgrade',snapshot.manifest.id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const j={formatVersion:1,transactionId:snapshot.manifest.id,zylosDir:root,skillsDir:path.join(root,'.claude/skills'),
        phase:'installing',installationIntent:true,dbBackupDir:snapshot.dbBackupDir,
        snapshotManifestHash:maintenance.hash(path.join(snapshot.dbBackupDir,'manifest.json')),
        initialIdentity:{databases:snapshot.manifest.databases.map(d=>({source:d.source,exists:d.status!=='missing'}))}};
      maintenance.update(dir,j);
      // The real recovery primitives preserve rescue/rename intents and replace the
      // whole database. No test-owned row/table copy or cursor reset is involved.
      recovery.rescue(dir,j);recovery.replaceDatabases(dir,j,snapshot.manifest);
      assert.equal(j.dbRestore['components/dashboard/dashboard.db'].complete,true);
      assert.equal(sha(dbPath),sha(snapshot.copy));
      store=new Store(dbPath);importer=new CoreLogImporter({store,zylosDir:root,batchLines:200});
      assert.equal(dashboardSchemaOwner.inspectSchema(store.db).currentVersion,20);
    },
    count(){return store.db.prepare('SELECT count(*) n FROM runtime_events').get().n;},
    cursors(){return store.db.prepare('SELECT * FROM core_log_cursors ORDER BY generation,file_ino').all();},
  };
}
test('snapshot sees whole100 or whole120 batch; physical restore resumes to170, no duplicate generation', async t=>{
  const f=fixture(t);fs.writeFileSync(f.file,lines(0,100));await f.import();assert.equal(f.count(),100);
  fs.appendFileSync(f.file,lines(100,20));let pre,post;
  f.importer.transactionObserver=point=>{if(point==='beforeCommit'){pre=f.snapshot('before');const db=new Database(pre.copy,{readonly:true});assert.equal(db.prepare('SELECT count(*) n FROM runtime_events').get().n,100);assert.equal(db.prepare('SELECT byte_offset n FROM core_log_cursors').get().n,Buffer.byteLength(lines(0,100)));db.close();}if(point==='afterCommit')post=f.snapshot('after');};
  await f.import();f.importer.transactionObserver=undefined;
  // Snapshot publication retires older groups; assert the pre-commit view while it exists above.
  const postDb=new Database(post.copy,{readonly:true});assert.equal(postDb.prepare('SELECT count(*) n FROM runtime_events').get().n,120);
  assert.equal(postDb.prepare('SELECT byte_offset n FROM core_log_cursors').get().n,Buffer.byteLength(lines(0,120)));postDb.close();
  assert.ok(pre);fs.appendFileSync(f.file,lines(120,50));await f.import();assert.equal(f.count(),170);
  await f.restore(post);assert.equal(f.count(),120);await f.import();assert.equal(f.count(),170);
  assert.equal(f.cursors().length,1);assert.equal(f.cursors()[0].generation,1);
});
for(const scenario of ['rotation','same-identity-replacement','new-identity-replacement','expired-cursor']) {
  test(`restored cursor continues retained logs: ${scenario}`,async t=>{
    const f=fixture(t);fs.writeFileSync(f.file,lines(0,100));await f.import();const snapshot=f.snapshot('saved');
    if(scenario==='rotation') {fs.appendFileSync(f.file,lines(100,10));fs.renameSync(f.file,path.join(path.dirname(f.file),'events.100.jsonl'));fs.writeFileSync(f.file,lines(110,10));}
    if(scenario==='same-identity-replacement') fs.writeFileSync(f.file,lines(1000,100));
    if(scenario==='new-identity-replacement'||scenario==='expired-cursor') {
      fs.renameSync(f.file,path.join(f.root,'retired.jsonl'));
      if(scenario==='expired-cursor')fs.writeFileSync(path.join(path.dirname(f.file),'events.100.jsonl'),lines(100,10));
      fs.writeFileSync(f.file,lines(1000,100));
    }
    await f.restore(snapshot);await f.import();
    assert.equal(f.count(),scenario==='rotation'?120:scenario==='expired-cursor'?210:200);
    if(scenario==='same-identity-replacement') {
      assert.deepEqual(f.cursors().map(c=>c.generation),[1,2]);assert.equal(f.cursors()[0].status,'gap');
      assert.deepEqual(f.store.getSourceHealth().filter(row=>row.extra.reason==='anchor_mismatch').map(row=>row.extra.reason),['anchor_mismatch']);
      const imported=f.store.queryEvents({limit:1000});
      assert.deepEqual(imported.filter(row=>row.ingest_id.includes(':g2:')).map(row=>row.event_type),Array.from({length:100},(_,n)=>`event${1000+n}`));
      assert.equal(new Set(imported.map(row=>row.ingest_id)).size,200);
      assert.deepEqual(imported.filter(row=>row.ingest_id.includes(':g1:')).map(row=>row.event_type),Array.from({length:100},(_,n)=>`event${n}`));
    }else if(scenario!=='rotation') {
      assert.ok(f.cursors().every(c=>c.generation===1));assert.equal(f.cursors().filter(c=>c.status==='gap').length,1);
    }
    if(scenario==='rotation')assert.deepEqual(f.store.queryEvents({limit:1000}).map(e=>e.event_type),Array.from({length:120},(_,n)=>`event${n}`));
    const before=f.count();await f.import();assert.equal(f.count(),before);
  });
}
