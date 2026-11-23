import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {migrateDatabase} from '../../../skills/comm-bridge/scripts/sqlite-schema.js';

const installed=process.env.CORE_DB_TEST_SKILL || path.resolve('skills/comm-bridge');
const Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');



test('migration engine gives uncoded callback failures a structured migration code and rolls back',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  const owner={SUPPORTED_SCHEMA_VERSION:1,inspectSchema:()=>({version:0,empty:true}),
    MIGRATIONS:{0:{to:1,migrate(database){database.exec('CREATE TABLE partial(value TEXT)');throw Error('uncoded callback failure');}}}};
  assert.throws(()=>migrateDatabase(db,owner,{allowNew:true}),error=>{
    assert.equal(error.code,'SCHEMA_MIGRATION_FAILED');
    assert.equal(error.message,'uncoded callback failure');
    return true;
  });
  assert.equal(db.inTransaction,false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(),undefined);
});
