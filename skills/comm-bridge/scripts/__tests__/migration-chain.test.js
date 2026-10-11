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
]) test(`historical ${name}: read-only plan, 0→1 data retention and no repeated migration`, () => {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(new URL(name, fixtures),'utf8'));
    db.exec(seed);
    const before=db.prepare(query).all();
    const schemaBefore=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    const plan=planDatabaseMigration(db,owner);
    assert.deepEqual(plan.steps.map(({from,to})=>[from,to]),[[0,1]]);
    assert.equal(db.pragma('user_version',{simple:true}),0);
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),schemaBefore);
    let calls=0;
    const counted={...owner,MIGRATIONS:{0:{to:1,migrate(connection,options){calls++;owner.MIGRATIONS[0].migrate(connection,options);}}}};
    migrateDatabase(db,counted);
    assert.equal(db.pragma('user_version',{simple:true}),1);
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

// Synthetic mechanism fixture only. No released owner has schema version 2.
function synthetic(fail=false) {
  return {
    SUPPORTED_SCHEMA_VERSION:2,supportsNewDatabase:true,
    inspectSchema(db,options={}) {
      const v=db.pragma('user_version',{simple:true});
      return inspectLayout(db,'synthetic',2,{items:v===0?['id','value']:v===1?['id','value','added']:['id','value','added','final']},options);
    },
    MIGRATIONS:{
      0:{to:1,migrate(db){db.exec("ALTER TABLE items ADD COLUMN added TEXT; UPDATE items SET value='step-one';");}},
      1:{to:2,migrate(db){db.exec("ALTER TABLE items ADD COLUMN final TEXT; UPDATE items SET value='step-two';");if(fail)throw Error('mid-chain failure');}},
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
 assert.throws(()=>migrateDatabase(db,owner),/missing items.final/);assert.equal(db.pragma('user_version',{simple:true}),0);assert.deepEqual(db.prepare('SELECT * FROM items').all(),[{id:1,value:'original'}]);
 }finally{db.close();}
});

test('historical fixture bytes match recorded immutable provenance',()=>{
 const provenance=JSON.parse(fs.readFileSync(new URL('provenance.json',fixtures),'utf8'));
 for(const entry of provenance.fixtures)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(entry.fixture,fixtures))).digest('hex'),entry.fixtureSha256,entry.fixture);
});
