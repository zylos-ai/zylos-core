import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { sendExternal } from '../skills/comm-bridge/scripts/c4-send-external.js';
import { systemSendEnvironment } from '../skills/comm-bridge/scripts/c4-system-send-env.js';
import { createBatchReceipt, verifyBatchReceipt } from '../skills/comm-bridge/scripts/c4-sync-batch.js';
import { projectConversation } from '../skills/comm-bridge/scripts/c4-query-format.js';

function setup(t) {
  const { db, store, filename } = fixture(t, {}, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'demo', 'scripts', 'send.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const api = { ...store, getDb: () => db };
  for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) {
    assert.ok(process.env[name]?.startsWith(path.dirname(os.tmpdir()) + path.sep), name);
  }
  assert.ok(filename.startsWith(os.tmpdir() + path.sep));
  console.info('Channel Sync isolation:', JSON.stringify({
    HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: os.tmpdir(), database: filename, script,
  }));
  return { api, db, store, dir, script };
}
const request = { channel: 'demo', endpoint: 'endpoint' };

// Private component process, notice provenance and startup reply query. Run for
// send failure/provenance changes; unrelated UI work may skip. No service or
// tmux is used. The runner owns isolated instance paths and fixture cleanup.
test('failed system notices preserve an unanswered human message', async t => {
  const { api, db, dir, script } = setup(t);
  api.insertConversation('in', 'demo', 'endpoint', 'human awaiting reply');
  fs.writeFileSync(script, 'process.exitCode=1;');
  await assert.rejects(sendExternal(request, 'system notice', { api, skillsDir: dir,
    env: systemSendEnvironment(process.env, { notice: true }) }), { code: 'SEND_FAILED', exitCode: 1 });
  const row = db.prepare("SELECT * FROM conversations WHERE direction='out'").get();
  assert.equal(row.status, 'failed');
  assert.equal(row.delivery_action, 'system_notice');
  for (const group of ['demo', '*']) {
    assert.equal(api.hasPendingStartupReply(group, { since: '2000-01-01T00:00:00Z' }), true);
  }
  fs.writeFileSync(script, 'process.exitCode=0;');
  await sendExternal(request, 'human reply', { api, skillsDir: dir });
  assert.equal(api.hasPendingStartupReply('demo', { since: '2000-01-01T00:00:00Z' }), false);
});

// Real component process plus private SQLite and Sync reads/receipts. Run for
// outbound settlement or Sync selection changes; skip unrelated UI work. The
// official runner isolates instance paths. The child exits within two seconds;
// cleanup releases and awaits it even after an assertion failure.
test('a send failing after export remains in scoped and global Sync batches', { timeout: 5000 }, async t => {
  const { api, db, dir, script, store } = setup(t);
  const started = path.join(dir, 'slow-started'), release = path.join(dir, 'release');
  fs.writeFileSync(script, `const fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    setInterval(() => { if(fs.existsSync(${JSON.stringify(release)})) process.exit(1); }, 10);
    setTimeout(() => process.exit(1), 2000);`);
  const human = api.insertConversation('in', 'demo', 'endpoint', 'human');
  db.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(human.id);
  const sending = sendExternal(request, 'slow reply', { api, skillsDir: dir }).then(() => null, error => error);
  try {
    for (let attempt = 0; attempt < 100 && !fs.existsSync(started); attempt++) await delay(10);
    assert.equal(fs.existsSync(started), true, 'real send must still be running at export');
    const outbound = db.prepare("SELECT * FROM conversations WHERE direction='out'").get();
    assert.equal(outbound.status, 'delivered');
    const receipts = ['demo', '*'].map(group => {
      const exported = store.queries.unsummarized({ group });
      assert.equal(exported.rows.length, 2);
      return createBatchReceipt(exported.rows.map(projectConversation), { scope: group, after: 0, end: exported.upTo });
    });
    fs.writeFileSync(release, 'release');
    const error = await sending;
    assert.equal(error?.code, 'SEND_FAILED');
    assert.equal(error.exitCode, 1);
    assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(outbound.id).status, 'failed');
    for (const receipt of receipts) {
      const group = receipt.scope;
      assert.equal(verifyBatchReceipt(receipt, { scope: group, end: receipt.end,
        database: { getConversationsByRange: (a, b) => db.prepare('SELECT * FROM conversations WHERE id>=? AND id<=?').all(a, b) } }).sha256, receipt.sha256);
      const exported = store.queries.unsummarized({ group });
      assert.equal(exported.rows.length, 2);
      assert.equal(exported.rows[1].id, outbound.id);
      assert.equal(exported.rows[1].status, 'failed');
      const range = group === '*' ? api.getGlobalUnsummarizedRange() : api.getUnsummarizedRange(group);
      assert.equal(range.count, 2);
      const page = store.queries.unsummarized({ group, limit: 1 });
      assert.equal(page.upTo, human.id, 'failed outbound remains on the next page');
      assert.throws(() => verifyBatchReceipt({ ...receipt, sha256: '0'.repeat(64) },
        { scope: group, end: receipt.end, database: { getConversationsByRange: () => exported.rows } }), { code: 'INPUT_CHANGED' });
    }
  } finally {
    fs.writeFileSync(release, 'release');
    await sending;
  }
});
