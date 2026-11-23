import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixture } from './c4-v2-test-helpers.js';
import { sendExternal } from '../c4-send-external.js';

function setup(t) {
  const { db, store, filename } = fixture(t, {}, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'demo', 'scripts', 'send.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const marker = path.join(dir, 'component-started');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`);
  const api = { ...store, getDb: () => db,
    getConversationsByRange: (a, b) => db.prepare('SELECT * FROM conversations WHERE id>=? AND id<=?').all(a, b) };
  return { db, store, filename, dir, script, marker, api };
}
const request = { channel: 'demo', endpoint: 'endpoint' };

test('audit rollback prevents component; actual exit failure preserves audit', async t => {
  const { api, db, dir, script, marker } = setup(t);
  db.exec("CREATE TRIGGER reject_send BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT,'reject'); END");
  await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), { code: 'DB_WRITE_FAILED' });
  assert.equal(fs.existsSync(marker), false); assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
  db.exec('DROP TRIGGER reject_send');
  fs.writeFileSync(script, 'process.exit(1)');
  await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), { code: 'SEND_FAILED', exitCode: 1 });
  assert.deepEqual(db.prepare('SELECT status,delivery_action FROM conversations').get(),
    { status: 'failed', delivery_action: 'send_failed' });
});

test('real component receives maximum endpoint and preserves shell metacharacters', async t => {
  const { api, dir, script, db, filename } = setup(t);
  const output = path.join(dir, 'argv.json');
  const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
  fs.writeFileSync(script, `const fs = require('node:fs'); const Database = require(${JSON.stringify(sqlite)});
    const db = new Database(${JSON.stringify(filename)}, {readonly:true});
    const rows = db.prepare('SELECT count(*) n FROM conversations').get().n;
    db.close(); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), rows}));`);
  for (const [index, endpoint] of ['x'.repeat(131071), 'a\'"$`\\\nroute'].entries()) {
    await sendExternal({ ...request, endpoint }, 'body', { api, skillsDir: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), { args: [endpoint, 'body'], rows: index + 1 });
  }
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 2);
});
