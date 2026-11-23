import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawn } from 'node:child_process';
import { Store } from '../src/lib/store.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';

const line = (event = 'a', size = 128) => {
  const text = JSON.stringify({ v: 1, ts: 0, event });
  return text + ' '.repeat(Math.max(0, size - Buffer.byteLength(text) - 1)) + '\n';
};
const injectedIdentity = async handle => ({ ...await handle.stat(), dev: 17, ino: 49 });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-import-'));
  const file = path.join(root, 'events.jsonl');
  const dbPath = path.join(root, 'dashboard.db');
  const store = new Store(dbPath);
  const importer = new CoreLogImporter({ store, zylosDir: root, batchLines: 2, ...options });
  t.after(async () => { await importer.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, dbPath, store, importer,
    write: text => fs.writeFileSync(file, text),
    append: text => fs.appendFileSync(file, text),
    read: () => importer.importStream({ stream: 'events:origin', file }),
    rows: () => store.db.prepare('SELECT * FROM core_log_cursors ORDER BY generation').all(),
    events: () => store.queryEvents(),
    diagnostics: () => store.getSourceHealth().map(r => r.extra),
  };
}

// Real importer/files/SQLite: run for active snapshot invalidation changes;
// skip unrelated UI. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR;
// no services, tmux or children; fixture cleanup closes importer and database.

// Database cursor invalidation with an unchanged real file: run for cache/cursor
// changes; skip UI. Same isolated runner and fixture cleanup; no background work.

test('two rotations between polls consume old tail, every middle and current; rename preserves identity', async t => {
  const f=fixture(t); f.write(line('old')); await f.read(); f.append(line('old-tail'));
  fs.renameSync(f.file,path.join(f.root,'events.100.jsonl')); f.write(line('middle'));
  fs.renameSync(f.file,path.join(f.root,'events.200.jsonl')); f.write(line('current')); await f.read();
  assert.deepEqual(f.events().map(e=>e.event_type),['old','old-tail','middle','current']);
  assert.equal(f.rows().length,3); assert.ok(f.rows().every(r=>r.generation===1));
  assert.equal(f.rows().filter(r=>r.status==='done').length,2);
  fs.renameSync(f.file,path.join(f.root,'events.300.jsonl')); f.write(line('next')); await f.read();
  assert.equal(f.events().length,5); assert.equal(f.rows().length,4);
  assert.equal(f.rows().filter(r=>r.status==='done').length,3);
});
async function crash(f, phase) {
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'fixtures/core-import-crash.js'),f.dbPath,f.file,phase,f.importer.statFile === injectedIdentity ? 'injected' : 'native'],
    {stdio:['ignore','pipe','pipe'],env:{...process.env,ZYLOS_DIR:f.root}});
  let stderr=''; child.stderr.on('data',d=>stderr+=d);
  const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  assert.equal(result.signal,'SIGKILL',stderr); return result;
}
test('actual process death after INSERT before COMMIT rolls both back; after COMMIT resumes without duplicate', async t => {
  const f=fixture(t); f.write(line('A')); await f.read(); const old=f.rows()[0]; f.append(line('B'));
  await crash(f,'afterInsert'); assert.deepEqual(f.rows(),[old]); assert.equal(f.events().length,1);
  await crash(f,'afterCommit'); assert.equal(f.rows()[0].byte_offset,256); assert.equal(f.events().length,2);
  await f.read(); assert.equal(f.events().length,2); assert.equal(f.rows().length,1);
});

test('diagnostic free text and receive rejection details use Sanitizer before indexing and again at output', async t => {
  const f = fixture(t); const secret = 'sk-' + 'a'.repeat(24);
  f.write(JSON.stringify({ v: 1, ts: 1, event: 'post_tool_failure', error: secret, reason: secret,
    reason_code: 'rejected', channel: 'telegram', endpoint: '123', detail: `failed: ${secret}` }) + '\n');
  await f.read(); const event = f.events()[0];
  assert.equal(event.metadata.error, '[REDACTED]'); assert.equal(event.metadata.reason, '[REDACTED]');
  assert.equal(event.metadata.detail, 'failed: [REDACTED]');
  assert.equal(event.metadata.reason_code, 'rejected'); assert.equal(event.metadata.channel, 'telegram'); assert.equal(event.metadata.endpoint, '123');
  assert.ok(!JSON.stringify(event).includes(secret));
  assert.ok(!JSON.stringify(await f.importer.sanitizeEvents([{ metadata: { error: secret, reason: secret } }])).includes(secret));
});
