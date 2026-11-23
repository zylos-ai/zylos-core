import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { inspectLayout, planDatabaseMigration, migrateDatabase, guardDatabase } from '../sqlite-schema.js';
import * as c4 from '../c4-schema.js';
import * as scheduler from '../../../scheduler/scripts/schema.js';
import * as web from '../../../../cli/lib/__tests__/fixtures/legacy-web-console-schema.js';
const fixtures = new URL('./fixtures/migration-history/', import.meta.url);

for (const [name, owner, seed, query] of [
  ...['v0.1.0','v0.4.11','v0.5.2'].map(tag => [`c4-${tag}.sql`,c4,"INSERT INTO conversations(direction,channel,endpoint_id,content) VALUES('in','web-console','session-handoff','retained')",'SELECT content FROM conversations']),
  ['scheduler-v0.1.0.sql',scheduler,"INSERT INTO system_state VALUES('retained','value',1)",'SELECT value FROM system_state'],
  ['web-console-v0.5.3.sql',web,"INSERT INTO sessions VALUES('retained',1,1)",'SELECT token FROM sessions'],
]) test(`historical ${name}: read-only plan, complete-chain data retention and no repeated migration`, () => {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(new URL(name, fixtures),'utf8'));
    db.exec(seed);
    const before=db.prepare(query).all();
    const schemaBefore=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    const plan=planDatabaseMigration(db,owner);
    assert.deepEqual(plan.steps.map(({from,to})=>[from,to]),Array.from({length:owner.SUPPORTED_SCHEMA_VERSION},(_,from)=>[from,from+1]));
    assert.equal(db.pragma('user_version',{simple:true}),0);
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),schemaBefore);
    let calls=0;
    const counted={...owner,MIGRATIONS:{...owner.MIGRATIONS,0:{...owner.MIGRATIONS[0],migrate(connection,options){calls++;owner.MIGRATIONS[0].migrate(connection,options);}}}};
    migrateDatabase(db,counted);
    assert.equal(db.pragma('user_version',{simple:true}),owner.SUPPORTED_SCHEMA_VERSION);
    assert.deepEqual(db.prepare(query).all(),before);
    if(owner===c4) assert.equal(db.prepare('SELECT channel FROM conversations').get().channel,'void');
    guardDatabase(db,counted);guardDatabase(db,counted);
    assert.equal(calls,1);
  } finally {db.close();}
});

// Synthetic mechanism fixture independent of the concrete owner versions.
function synthetic(fail=false) {
  return {
    SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:true,
    inspectSchema(db,options={}) {
      const v=db.pragma('user_version',{simple:true});
      return inspectLayout(db,'synthetic',2,{items:v===0?['id','value']:v===1?['id','value','added']:['id','value','added','final']},options);
    },
    MIGRATIONS:{
      0:{to:1,changes:{addColumns:{items:{added:{type:'TEXT',pk:false}}}},migrate(db){db.exec("ALTER TABLE items ADD COLUMN added TEXT; UPDATE items SET value='step-one';");}},
      1:{to:2,changes:{addColumns:{items:{final:{type:'TEXT',pk:false}}}},migrate(db){db.exec("ALTER TABLE items ADD COLUMN final TEXT; UPDATE items SET value='step-two';");if(fail)throw Error('mid-chain failure');}},
    },
  };
}
test('synthetic later-step failure restores entire chain structure, data and starting version',()=>{
 const db=new Database(':memory:');try{
 db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'original')");
 const before=db.prepare('SELECT * FROM sqlite_master').all();
 assert.throws(()=>migrateDatabase(db,synthetic(true)),/mid-chain failure/);
 assert.deepEqual(db.prepare('SELECT * FROM sqlite_master').all(),before);
 assert.deepEqual(db.prepare('SELECT * FROM items').all(),[{id:1,value:'original'}]);assert.equal(db.pragma('user_version',{simple:true}),0);
 }finally{db.close();}
});

// Synthetic future owner exercising a longer chain. The extension
// column and archive table model locally owned data carried across core DDL.
function syntheticV9({failAtRebuild=false,discardExtension=false}={}) {
 const columns=version=>version<2?['id','value']:
  version<3?['id','value','added']:
  version<6?['id','body','added']:
  version<9?['id','body']:['id','body','status'];
 const def=(type,pk=false)=>({type,pk});
 return {
  name:'future-owner',SUPPORTED_SCHEMA_VERSION:9,supportsNewDatabase:false,
  inspectSchema(db,options={}) {
   const version=db.pragma('user_version',{simple:true});
   const table=version<5?'items':'entries';
   const tables={[table]:columns(version)};
   if(version>=4 && version<8)tables.labels=['id','name'];
   return inspectLayout(db,'future-owner',9,tables,options);
  },
  MIGRATIONS:{
   1:{to:2,changes:{addColumns:{items:{added:def('TEXT')}}},migrate(db){db.exec('ALTER TABLE items ADD COLUMN added TEXT');}},
   2:{to:3,changes:{renameColumns:[{table:'items',from:'value',to:'body'}]},migrate(db){db.exec('ALTER TABLE items RENAME COLUMN value TO body');}},
   3:{to:4,changes:{addTables:{labels:{id:def('INTEGER',true),name:def('TEXT')}}},migrate(db){db.exec('CREATE TABLE labels(id INTEGER PRIMARY KEY,name TEXT)');}},
   4:{to:5,changes:{renameTables:[{from:'items',to:'entries'}]},migrate(db){db.exec('ALTER TABLE items RENAME TO entries');}},
   5:{to:6,changes:{dropColumns:{entries:['added']}},migrate(db){db.exec('ALTER TABLE entries DROP COLUMN added');}},
   6:{to:7,changes:{rebuildTables:['entries']},migrate(db){
    db.exec(`CREATE TABLE rebuilt_entries(id INTEGER PRIMARY KEY,body TEXT${discardExtension?'':',external TEXT'});
      INSERT INTO rebuilt_entries(id,body${discardExtension?'':',external'}) SELECT id,body${discardExtension?'':',external'} FROM entries;
      DROP TABLE entries; ALTER TABLE rebuilt_entries RENAME TO entries`);
    if(failAtRebuild)throw Error('injected rebuild failure');
   }},
   7:{to:8,changes:{dropTables:{labels:['id','name']}},migrate(db){db.exec('DROP TABLE labels');}},
   8:{to:9,changes:{addColumns:{entries:{status:def('TEXT')}}},migrate(db){db.exec("ALTER TABLE entries ADD COLUMN status TEXT DEFAULT 'ready'");}},
  },
 };
}
function seedV9(db,version=1,{extraColumn='external',labelExtra=false}={}) {
 db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT,${extraColumn} TEXT);
   INSERT INTO items VALUES(1,'retained','extension-value');
   CREATE TABLE archive_records(id INTEGER PRIMARY KEY,value TEXT);
   INSERT INTO archive_records VALUES(7,'archive-value');
   PRAGMA user_version=1`);
 const owner=syntheticV9();
 for(let current=1;current<version;current++) {
  owner.MIGRATIONS[current].migrate(db);
  db.pragma(`user_version=${current+1}`);
 }
 if(labelExtra)db.exec('ALTER TABLE labels ADD COLUMN external_label TEXT');
}
const extensionOptions={allowExtraTables:true,allowExtraColumns:true};
function v9State(db) {
 return {
  schema:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
  rows:db.prepare(`SELECT * FROM ${db.pragma('user_version',{simple:true})<5?'items':'entries'}`).all(),
  archive:db.prepare('SELECT * FROM archive_records').all(),
  version:db.pragma('user_version',{simple:true}),
 };
}

test('synthetic v1→v9 add, drop, rename and rebuild retain extension rows and columns',()=>{
 const db=new Database(':memory:');try {
  seedV9(db);
  const owner=syntheticV9();
  const before=v9State(db);
  const plan=planDatabaseMigration(db,owner,extensionOptions);
  assert.deepEqual(plan.steps.map(step=>[step.from,step.to]),Array.from({length:8},(_,i)=>[i+1,i+2]));
  assert.deepEqual(v9State(db),before);
  const result=migrateDatabase(db,owner,extensionOptions);
  assert.equal(result.version,9);
  assert.deepEqual(result.extensions,{tables:['archive_records'],columns:[{table:'entries',column:'external'}]});
  assert.deepEqual(db.prepare('SELECT id,body,external,status FROM entries').all(),[{id:1,body:'retained',external:'extension-value',status:'ready'}]);
  assert.deepEqual(db.prepare('SELECT * FROM archive_records').all(),[{id:7,value:'archive-value'}]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='labels'").get(),undefined);
  const after=v9State(db);migrateDatabase(db,owner,extensionOptions);assert.deepEqual(v9State(db),after);
 }finally{db.close();}
});

test('C4 v1 migrates to current schema and retains rows and user extensions', () => {
 const db=new Database(':memory:');try {
  db.exec(fs.readFileSync(new URL('c4-v0.9.0-v1.sql',fixtures),'utf8'));
  db.exec("CREATE TABLE archive_records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO archive_records VALUES(1,'retained'); ALTER TABLE checkpoints ADD COLUMN external TEXT; UPDATE checkpoints SET external='kept'");
  const before=db.prepare('SELECT * FROM checkpoints ORDER BY id').all();
  assert.deepEqual(planDatabaseMigration(db,c4,extensionOptions).steps.map(({from,to})=>[from,to]),[[1,2],[2,3],[3,4],[4,5]]);
  const result=migrateDatabase(db,c4,extensionOptions);
  assert.equal(result.version,c4.SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(db.prepare('SELECT id,timestamp,summary,start_conversation_id,end_conversation_id,external FROM checkpoints ORDER BY id').all(),before);
  assert.equal(db.prepare('SELECT value FROM archive_records').get().value,'retained');
  for(const name of ['status_notice_attempts','runtime_health_events','runtime_health_state'])
    assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name),undefined);
  assert.equal(planDatabaseMigration(db,c4,extensionOptions).steps.length,0);
 }finally{db.close();}
});

test('rowChanges must declare an intentional row-count change',()=>{
 for(const declared of [false,true]) {
  const db=new Database(':memory:');try {
   db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'kept'); PRAGMA user_version=1");
   const owner={name:'row-change',SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:false,
    inspectSchema(connection,options){return inspectLayout(connection,'row-change',2,{items:['id','value']},options);},
    MIGRATIONS:{1:{to:2,changes:declared?{rowChanges:['items']}:{},migrate(connection){connection.exec("INSERT INTO items VALUES(2,'new')");}}},
   };
   if(declared) {
    migrateDatabase(db,owner);
    assert.equal(db.pragma('user_version',{simple:true}),2);
    assert.deepEqual(db.prepare('SELECT value FROM items ORDER BY id').all(),[{value:'kept'},{value:'new'}]);
   } else {
    assert.throws(()=>migrateDatabase(db,owner),/undeclared row-count change in items/);
    assert.equal(db.pragma('user_version',{simple:true}),1);
    assert.deepEqual(db.prepare('SELECT value FROM items').all(),[{value:'kept'}]);
   }
  }finally{db.close();}
 }
});
