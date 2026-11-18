import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const Database=createRequire(process.argv[2])('better-sqlite3');
const db=new Database(':memory:');
try {assert.equal(db.prepare('SELECT 1 AS ok').get().ok,1);console.log('1');}
finally {db.close();}
