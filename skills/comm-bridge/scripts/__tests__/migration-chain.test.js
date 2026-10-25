import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { inspectLayout, planDatabaseMigration, migrateDatabase, guardDatabase } from '../sqlite-schema.js';
import * as c4 from '../c4-schema.js';
import * as scheduler from '../../../scheduler/scripts/schema.js';
import * as web from '../../../web-console/scripts/schema.js';
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
    assert.deepEqual(plan.steps.map(({from,to})=>[from,to]),owner===c4 || owner===scheduler?[[0,1],[1,2]]:[[0,1]]);
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

test('historical C4 ALTER-added nullable raw_content shape backfills ACK suffix',()=>{
  const db=new Database(':memory:');
  try {
    db.exec(fs.readFileSync(new URL('c4-v0.1.0.sql',fixtures),'utf8'));
    // Derived shape: the historical v0.4.11 runtime ALTER, not fresh-init SQL.
    db.exec('ALTER TABLE control_queue ADD COLUMN raw_content TEXT');
    db.prepare('INSERT INTO control_queue(content,created_at,updated_at) VALUES(?,1,1)').run('work ---- ack via: node example ack --id 7');
    migrateDatabase(db,c4);
    assert.equal(db.prepare('SELECT raw_content FROM control_queue').get().raw_content,'work');
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
for(const from of [0,1])test(`synthetic version ${from}→2 executes complete remaining chain`,()=>{
 const db=new Database(':memory:');try{
 db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'original')");
 if(from===1){synthetic().MIGRATIONS[0].migrate(db);db.pragma('user_version=1');}
 const owner=synthetic();assert.equal(planDatabaseMigration(db,owner).steps.length,2-from);
 migrateDatabase(db,owner);assert.equal(db.pragma('user_version',{simple:true}),2);assert.equal(db.prepare('SELECT value FROM items').get().value,'step-two');
 }finally{db.close();}
});
test('synthetic later-step failure restores entire chain structure, data and starting version',()=>{
 const db=new Database(':memory:');try{
 db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'original')");
 const before=db.prepare('SELECT * FROM sqlite_master').all();
 assert.throws(()=>migrateDatabase(db,synthetic(true)),/mid-chain failure/);
 assert.deepEqual(db.prepare('SELECT * FROM sqlite_master').all(),before);
 assert.deepEqual(db.prepare('SELECT * FROM items').all(),[{id:1,value:'original'}]);assert.equal(db.pragma('user_version',{simple:true}),0);
 }finally{db.close();}
});
test('missing or malformed later step is rejected before first callback or writes',()=>{
 for(const step of [undefined,{to:3,migrate(){}},{to:2}]) {
 const db=new Database(':memory:');try{
 db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'original')");
 const owner=synthetic();owner.MIGRATIONS[0].migrate=()=>assert.fail('first step must not run');owner.MIGRATIONS[1]=step;
 assert.throws(()=>migrateDatabase(db,owner),/migration path/);assert.equal(db.pragma('user_version',{simple:true}),0);assert.equal(db.prepare('SELECT value FROM items').get().value,'original');
 }finally{db.close();}
 }
});
test('invalid target layout after a step rolls back data and version',()=>{
 const db=new Database(':memory:');try{
 db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'original')");
 const owner=synthetic();owner.MIGRATIONS[1].migrate=db=>db.exec("UPDATE items SET value='bad'");
 assert.throws(()=>migrateDatabase(db,owner),/items.final/);assert.equal(db.pragma('user_version',{simple:true}),0);assert.deepEqual(db.prepare('SELECT * FROM items').all(),[{id:1,value:'original'}]);
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

test('v1+ rebuild cannot silently discard a generated extension column',()=>{
 const db=new Database(':memory:');try{
  db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, body TEXT, external TEXT GENERATED ALWAYS AS (body || '-derived') VIRTUAL); INSERT INTO entries(id,body) VALUES (1,'kept'); PRAGMA user_version=1");
  const owner={name:'generated-extension',SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:false,
   inspectSchema(db,options){return inspectLayout(db,'generated-extension',2,{entries:['id','body']},options);},
   MIGRATIONS:{1:{to:2,changes:{rebuildTables:['entries']},migrate(db){db.exec('CREATE TABLE replacement(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO replacement SELECT id,body FROM entries; DROP TABLE entries; ALTER TABLE replacement RENAME TO entries');}}}};
  assert.throws(()=>migrateDatabase(db,owner,extensionOptions),/undeclared removal of column entries\.external/);
  assert.equal(db.pragma('user_version',{simple:true}),1);
  assert.equal(db.prepare('SELECT external FROM entries').get().external,'kept-derived');
 }finally{db.close();}
});

test('v1+ rebuild cannot change a retained column definition without declaration',()=>{
 const db=new Database(':memory:');try{
  db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, body TEXT DEFAULT 'before'); INSERT INTO entries(id,body) VALUES (1,'kept'); PRAGMA user_version=1");
  const owner={name:'definition-change',SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:false,
   inspectSchema(db,options){return inspectLayout(db,'definition-change',2,{entries:['id','body']},options);},
   MIGRATIONS:{1:{to:2,changes:{rebuildTables:['entries']},migrate(db){db.exec("CREATE TABLE replacement(id INTEGER PRIMARY KEY,body TEXT DEFAULT 'after'); INSERT INTO replacement SELECT * FROM entries; DROP TABLE entries; ALTER TABLE replacement RENAME TO entries");}}}};
  assert.throws(()=>migrateDatabase(db,owner),/undeclared definition change in entries\.body/);
  assert.equal(db.pragma('user_version',{simple:true}),1);
  assert.equal(db.pragma('table_info(entries)').find(row=>row.name==='body').dflt_value,"'before'");
 }finally{db.close();}
});

function alteredCoreOwner({declareChange=true,changeExtension=false,declareExtension=false,incomplete=false,wrongTarget=false}={}) {
 const coreDefinition={type:wrongTarget?'REAL':'INTEGER',pk:false,notnull:true,default:'7'};
 const alterColumns={items:{value:incomplete?{type:'INTEGER',pk:false}:coreDefinition}};
 if(declareExtension)alterColumns.items.external={type:'TEXT',pk:false,notnull:false,default:"'changed'"};
 const changes={rebuildTables:['items']};
 if(declareChange || declareExtension)changes.alterColumns=alterColumns;
 return {
  name:'alter-core',SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:false,TABLES:{items:['id','value']},
  inspectSchema(db,options){
   const version=db.pragma('user_version',{simple:true});
   return inspectLayout(db,'alter-core',2,{items:['id','value']},{...options,definitions:{items:{id:{type:'INTEGER',pk:true},value:{type:version===1?'TEXT':'INTEGER',pk:false}}}});
  },
  MIGRATIONS:{1:{to:2,changes,migrate(db){
   db.exec(`CREATE TABLE replacement(id INTEGER PRIMARY KEY,value INTEGER NOT NULL DEFAULT 7,external TEXT DEFAULT '${changeExtension?'changed':'user'}');
     INSERT INTO replacement(id,value,external) SELECT id,value,external FROM items;
     DROP TABLE items; ALTER TABLE replacement RENAME TO items`);
  }}},
 };
}
function seedAlterCore(db) {
 db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT DEFAULT 'before',external TEXT DEFAULT 'user'); INSERT INTO items(id,value,external) VALUES(1,'17','retained'); PRAGMA user_version=1");
}
test('declared v1+ core type, NOT NULL and default changes preserve extension definition and data',()=>{
 const db=new Database(':memory:');try{
  seedAlterCore(db);
  const result=migrateDatabase(db,alteredCoreOwner(),extensionOptions);
  assert.deepEqual(result.extensions,{tables:[],columns:[{table:'items',column:'external'}]});
  assert.deepEqual(db.prepare('SELECT id,value,external FROM items').all(),[{id:1,value:17,external:'retained'}]);
  const columns=Object.fromEntries(db.pragma('table_xinfo(items)').map(row=>[row.name,row]));
  assert.deepEqual([columns.value.type,columns.value.notnull,columns.value.dflt_value],['INTEGER',1,'7']);
  assert.deepEqual([columns.external.type,columns.external.notnull,columns.external.dflt_value],['TEXT',0,"'user'"]);
 }finally{db.close();}
});
test('a name scheduled to become core later remains an extension in earlier steps',()=>{
 const db=new Database(':memory:');try{
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,future TEXT DEFAULT 'user'); INSERT INTO items(id,future) VALUES(1,'retained'); PRAGMA user_version=1");
  let callbackRan=false;
  const owner={name:'future-core',SUPPORTED_SCHEMA_VERSION:3,supportsNewDatabase:false,TABLES:{items:['id','future']},
   inspectSchema(connection,options){
    const version=connection.pragma('user_version',{simple:true});
    return inspectLayout(connection,'future-core',3,{items:version===3?['id','future']:['id']},options);
   },
   MIGRATIONS:{
    1:{to:2,changes:{alterColumns:{items:{future:{type:'INTEGER',pk:false,notnull:false,default:'0'}}}},migrate(){callbackRan=true;}},
    2:{to:3,changes:{addColumns:{items:{future:{type:'TEXT',pk:false}}}},migrate(){callbackRan=true;}},
   },
  };
  const before=alterCoreState(db);
  assert.throws(()=>migrateDatabase(db,owner,extensionOptions),/cannot alter non-core column items\.future/);
  assert.equal(callbackRan,false);
  assert.deepEqual(alterCoreState(db),before);
 }finally{db.close();}
});
for(const [name,options,pattern] of [
 ['undeclared core definition change',{declareChange:false},/undeclared definition change in items\.value/],
 ['incomplete core declaration',{incomplete:true},/alterColumns|definition/],
 ['incorrect declared target definition',{wrongTarget:true},/alterColumns|definition/],
 ['extension definition change',{changeExtension:true},/undeclared definition change in items\.external/],
 ['declaration for extension column',{declareExtension:true},/alterColumns|extension|core column/],
])test(`v1+ ${name} rolls back the rebuild`,()=>{
 const db=new Database(':memory:');try{
  seedAlterCore(db);
  const before=alterCoreState(db);
  assert.throws(()=>migrateDatabase(db,alteredCoreOwner(options),extensionOptions),pattern);
  assert.deepEqual(alterCoreState(db),before);
 }finally{db.close();}
});
function alterCoreState(db) {
 return {schema:db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),rows:db.prepare('SELECT * FROM items').all(),version:db.pragma('user_version',{simple:true})};
}

for(const [definition,usable] of [
 ['NOT NULL',false],['NOT NULL DEFAULT NULL',false],
 ["NOT NULL DEFAULT 'safe'",true],['NOT NULL DEFAULT 0',true],
])test(`core table extension ${definition} ${usable?'has':'lacks'} a usable default`,()=>{
 const db=new Database(':memory:');try{
  db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT,external TEXT ${definition}); PRAGMA user_version=1`);
  const inspect=()=>inspectLayout(db,'extension-default',1,{items:['id','value']},extensionOptions);
  if(usable)assert.deepEqual(inspect().extensions.columns,[{table:'items',column:'external'}]);
  else assert.throws(inspect,/external.*default|default.*external/);
 }finally{db.close();}
});

test('C4 v1 migrates to current schema and retains rows and user extensions', () => {
 const db=new Database(':memory:');try {
  db.exec(fs.readFileSync(new URL('c4-v0.9.0-v1.sql',fixtures),'utf8'));
  db.exec("CREATE TABLE archive_records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO archive_records VALUES(1,'retained'); ALTER TABLE checkpoints ADD COLUMN external TEXT; UPDATE checkpoints SET external='kept'");
  const before=db.prepare('SELECT * FROM checkpoints ORDER BY id').all();
  assert.deepEqual(planDatabaseMigration(db,c4,extensionOptions).steps.map(({from,to})=>[from,to]),[[1,2]]);
  const result=migrateDatabase(db,c4,extensionOptions);
  assert.equal(result.version,c4.SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(db.prepare('SELECT id,timestamp,summary,start_conversation_id,end_conversation_id,external FROM checkpoints ORDER BY id').all(),before);
  assert.equal(db.prepare('SELECT value FROM archive_records').get().value,'retained');
  for(const name of ['status_notice_attempts','runtime_health_events','runtime_health_state'])
    assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name),undefined);
  assert.equal(planDatabaseMigration(db,c4,extensionOptions).steps.length,0);
 }finally{db.close();}
});

for(const [name,base,table,query,marker] of [
 ['scheduler',scheduler,'system_state','SELECT key,value FROM system_state','synthetic scheduler v1 state'],
 ['web-console',web,'sessions','SELECT token FROM sessions','fixture-web-v1'],
])test(`tagged ${name} v1 fixture migrates through current to a synthetic next version with rows and extensions retained`,()=>{
 const db=new Database(':memory:');try{
  db.exec(fs.readFileSync(new URL(`${name}-v0.9.0-v1.sql`,fixtures),'utf8'));
  assert.equal(db.pragma('user_version',{simple:true}),1);
  assert.equal(base.inspectSchema(db).version,1);
  const currentVersion=base.SUPPORTED_SCHEMA_VERSION, nextVersion=currentVersion+1;
  migrateDatabase(db,base);
  const reference=new Database(':memory:');
  try{
   migrateDatabase(reference,base,{allowNew:true});
   const schema=connection=>connection.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
   assert.deepEqual(schema(db),schema(reference));
  }finally{reference.close();}
  db.exec(`CREATE TABLE archive_records(id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO archive_records VALUES(1,'retained');
    ALTER TABLE ${table} ADD COLUMN external TEXT;
    UPDATE ${table} SET external='retained core extension'`);
  const before=db.prepare(query).all();
  assert.ok(before.some(row=>Object.values(row).includes(marker)));
  const tables={...base.TABLES,[table]:[...base.TABLES[table],'fixture_v2']};
  const definitions={...base.COLUMN_DEFINITIONS,[table]:{...base.COLUMN_DEFINITIONS[table],fixture_v2:{type:'TEXT',pk:false}}};
  const owner={...base,name:`${name}-future`,SUPPORTED_SCHEMA_VERSION:nextVersion,TABLES:tables,
   inspectSchema(connection,options){
    const version=connection.pragma('user_version',{simple:true});
    return inspectLayout(connection,`${name}-future`,nextVersion,version===currentVersion?base.TABLES:tables,{...options,definitions:version===currentVersion?base.COLUMN_DEFINITIONS:definitions});
   },
   MIGRATIONS:{...base.MIGRATIONS,[currentVersion]:{to:nextVersion,changes:{addColumns:{[table]:{fixture_v2:{type:'TEXT',pk:false}}}},migrate(connection){connection.exec(`ALTER TABLE ${table} ADD COLUMN fixture_v2 TEXT`);}}},
  };
  const result=migrateDatabase(db,owner,extensionOptions);
  assert.equal(result.version,nextVersion);
  assert.deepEqual(result.extensions,{tables:['archive_records'],columns:[{table,column:'external'}]});
  assert.deepEqual(db.prepare(query).all(),before);
  assert.ok(db.prepare(`SELECT external FROM ${table}`).all().every(row=>row.external==='retained core extension'));
  assert.equal(db.prepare('SELECT value FROM archive_records').get().value,'retained');
 }finally{db.close();}
});

test('v1+ drop-table declaration must match every existing column exactly',()=>{
 const db=new Database(':memory:');try{
  db.exec("CREATE TABLE labels(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO labels VALUES(1,'kept'); PRAGMA user_version=1");
  let callbackRan=false;
  const owner={name:'drop-declaration',SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:false,
   inspectSchema(db,options){const version=db.pragma('user_version',{simple:true});return inspectLayout(db,'drop-declaration',2,version===1?{labels:['id','name']}:{},options);},
   MIGRATIONS:{1:{to:2,changes:{dropTables:{labels:['id','name','ghost']}},migrate(db){callbackRan=true;db.exec('DROP TABLE labels');}}}};
  assert.throws(()=>migrateDatabase(db,owner),/declared columns absent labels\.ghost/);
  assert.equal(callbackRan,false);assert.equal(db.pragma('user_version',{simple:true}),1);
  assert.equal(db.prepare('SELECT name FROM labels').get().name,'kept');
 }finally{db.close();}
});

for(const [name,version,extraColumn,labelExtra,pattern] of [
 ['added core column',1,'added',false,/new core column items\.added collides with existing column/],
 ['renamed core column',2,'body',false,/colliding column rename items\.value→body/],
 ['dropped core table with extension field',7,'external',true,/cannot remove labels; undeclared columns labels\.external_label/],
])test(`synthetic v1→v9 refuses ${name} collision without writes`,()=>{
 const db=new Database(':memory:');try {
  seedV9(db,version,{extraColumn,labelExtra});
  const before=v9State(db);
  assert.throws(()=>migrateDatabase(db,syntheticV9(),extensionOptions),pattern);
  assert.deepEqual(v9State(db),before);
 }finally{db.close();}
});

for(const [name,options,pattern] of [
 ['callback failure',{failAtRebuild:true},/injected rebuild failure/],
 ['undeclared extension removal',{discardExtension:true},/undeclared removal of column entries\.external/],
])test(`synthetic v1→v9 ${name} rolls back the entire chain`,()=>{
 const db=new Database(':memory:');try {
  seedV9(db);const before=v9State(db);
  assert.throws(()=>migrateDatabase(db,syntheticV9(options),extensionOptions),pattern);
  assert.deepEqual(v9State(db),before);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='rebuilt_entries'").get(),undefined);
 }finally{db.close();}
});

test('maybeColumns creates a missing column, accepts a matching one, and rejects a mismatched one',()=>{
 for(const state of ['missing','matching','mismatched']) {
  const db=new Database(':memory:');try {
   db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT${state==='missing'?'':`,optional ${state==='matching'?'TEXT':'INTEGER'}`});
     INSERT INTO items(id,value) VALUES(1,'kept'); PRAGMA user_version=1`);
   if(state==='matching')db.exec("UPDATE items SET optional='extension-value'");
   let ran=false;
   const owner={name:'optional-column',SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:false,
    inspectSchema(connection,options){
     const tables={items:connection.pragma('user_version',{simple:true})===1?['id','value']:['id','value','optional']};
     return inspectLayout(connection,'optional-column',2,tables,options);
    },
    MIGRATIONS:{1:{to:2,changes:{maybeColumns:{items:{optional:{type:'TEXT',pk:false}}}},migrate(connection){
     ran=true;
     if(!connection.prepare('PRAGMA table_xinfo(items)').all().some(column=>column.name==='optional'))
      connection.exec('ALTER TABLE items ADD COLUMN optional TEXT');
    }}},
   };
   if(state==='mismatched') {
    assert.throws(()=>migrateDatabase(db,owner,{strict:false}),/unsupported definition for items\.optional/);
    assert.equal(ran,false);assert.equal(db.pragma('user_version',{simple:true}),1);
   } else {
    migrateDatabase(db,owner,{strict:false});
    assert.equal(db.pragma('user_version',{simple:true}),2);
    assert.deepEqual(db.prepare('SELECT id,value,optional FROM items').all(),
     [{id:1,value:'kept',optional:state==='matching'?'extension-value':null}]);
   }
  }finally{db.close();}
 }
});

test('maybeTables creates a missing table, accepts a matching one, and rejects a mismatched one',()=>{
 for(const state of ['missing','matching','mismatched']) {
  const db=new Database(':memory:');try {
   db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'kept'); PRAGMA user_version=1");
   if(state!=='missing')db.exec(`CREATE TABLE metadata(id INTEGER PRIMARY KEY,label ${state==='matching'?'TEXT':'INTEGER'}); INSERT INTO metadata VALUES(7,${state==='matching'?"'extension-value'":'42'})`);
   let ran=false;
   const owner={name:'optional-table',SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:false,
    inspectSchema(connection,options){
     const tables={items:['id','value']};
     if(connection.pragma('user_version',{simple:true})===2)tables.metadata=['id','label'];
     return inspectLayout(connection,'optional-table',2,tables,options);
    },
    MIGRATIONS:{1:{to:2,changes:{maybeTables:{metadata:{id:{type:'INTEGER',pk:true},label:{type:'TEXT',pk:false}}}},migrate(connection){
     ran=true;connection.exec('CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,label TEXT)');
    }}},
   };
   if(state==='mismatched') {
    assert.throws(()=>migrateDatabase(db,owner,{strict:false}),/unsupported definition for metadata\.label/);
    assert.equal(ran,false);assert.equal(db.pragma('user_version',{simple:true}),1);
    assert.equal(db.prepare('SELECT label FROM metadata').get().label,42);
   } else {
    migrateDatabase(db,owner,{strict:false});
    assert.equal(db.pragma('user_version',{simple:true}),2);
    assert.equal(db.prepare('SELECT value FROM items').get().value,'kept');
    assert.deepEqual(db.prepare('SELECT id,label FROM metadata').all(),
     state==='matching'?[{id:7,label:'extension-value'}]:[]);
   }
  }finally{db.close();}
 }
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

test('historical fixture bytes match recorded immutable provenance',()=>{
 const provenance=JSON.parse(fs.readFileSync(new URL('provenance.json',fixtures),'utf8'));
 const repo=new URL('../../../../',import.meta.url);
 for(const entry of provenance.fixtures){
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(entry.fixture,fixtures))).digest('hex'),entry.fixtureSha256,entry.fixture);
  for(const source of entry.sources || []){
   const bytes=fs.readFileSync(new URL(source.source,repo));
   assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),source.sourceSha256,source.source);
   assert.equal(crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'),source.sourceBlobSha,source.source);
  }
 }
});
