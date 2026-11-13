import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { acquire, memoryScope } from '../sync-lock.js';
import { renderStateSkeleton } from '../state-format.js';
import { cleanup, list, commit } from '../sync-files.js';
import { createBatchReceipt } from '../../../comm-bridge/scripts/c4-sync-batch.js';
import { projectConversation } from '../../../comm-bridge/scripts/c4-query-format.js';
const segment = '20261019T053002123Z';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-workflow-crash-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const { db, store } = storeFixture(t, {}, path.join(root, 'comm-bridge', 'c4.db'));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'crash-test', ZYLOS_SESSION_GROUP: 'origin' };
  const scope = await memoryScope(env);
  fs.mkdirSync(scope.runDir, { recursive: true }); fs.mkdirSync(scope.memoryDir, { recursive: true });
  const token = await acquire({ env, kind: 'group' }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const original = renderStateSkeleton({ scope: 'origin', syncedAt: '2026-10-19T00:00:00Z' });
  const state = path.join(scope.memoryDir, 'state.md'), temporary = `${state}.${token}.tmp`, piece = path.join(scope.memoryDir, `inbox.${segment}.md`);
  fs.writeFileSync(state, original); fs.writeFileSync(piece, 'commitment: keep this');
  fs.writeFileSync(temporary, original.replace('coverage= ', 'coverage=2 ').replace('inbox_committed= ', `inbox_committed=${segment} `).replace('## Headline\n', '## Headline\nRecovered\n'));
  db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(1,'in','system','one','delivered','origin'),(2,'in','system','two','delivered','origin')").run();
  const database = { ...store, getConversationsByRange: (begin, end) => db.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ? ORDER BY id').all(begin, end) };
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, env, state, temporary, piece, original, db, store, database, settings: { token, env } };
}
async function killAt(t, f, phase, end) {
  const worker = fileURLToPath(new URL('./fixtures/sync-crash-worker.js', import.meta.url));
  const child = spawn(process.execPath, [worker, phase, String(end), f.settings.token], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let errors = Buffer.alloc(0), timer, stage;
  child.stderr.on('data', data => { errors = Buffer.concat([errors, data]).subarray(-4096); });
  try {
    stage = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data).trim()),
      closed.then(() => { throw new Error(`Worker exited before crash barrier: ${errors.toString()}`); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`Worker timed out before crash barrier: ${errors.toString()}`)), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  assert.equal(child.signalCode, 'SIGKILL');
  return stage;
}
// Integration boundary: real guarded files + SQLite checkpoints + a killed child;
// only private fixture directories are touched. Run under the isolation launcher.
test('two real checkpoint-before-rename crashes retain inputs and both delta summaries', async t => {
  const f = await fixture(t);
  for (const end of [1, 2]) {
    assert.equal(await killAt(t, f, 'before-rename', end), 'checkpoint-written');
    assert.equal(fs.readFileSync(f.state, 'utf8'), f.original);
    assert.equal(fs.existsSync(f.piece), true);
    assert.deepEqual((await list(f.settings)).segments.map(item => item.id), [segment]);
  }
  assert.deepEqual(f.store.getContentCheckpointsSince('origin', 0).map(cp => cp.summary), ['summary 1', 'summary 2']);
  // Recovery only when the caller actually starts another Sync; reads above do not repair.
  const batch = createBatchReceipt(f.database.getConversationsByRange(1, 2).map(projectConversation), { scope: 'origin', after: 0, end: 2 });
  await commit({ ...f.settings, input: { followedUpIds: [], inputs: await list(f.settings), batch } }, { database: f.database });
  assert.match(fs.readFileSync(f.state, 'utf8'), /Recovered/); assert.equal(fs.existsSync(f.piece), false);
});
// Integration boundary: kill after the actual rename, then retry real cleanup
// against the retained fixture segment to prove the publication/deletion boundary.
test('real rename-before-delete crash publishes state and cleanup removes retained committed input', async t => {
  const f = await fixture(t);
  assert.equal(await killAt(t, f, 'after-rename', 2), 'state-published');
  assert.match(fs.readFileSync(f.state, 'utf8'), /Recovered/);
  assert.equal(fs.existsSync(f.piece), true); assert.deepEqual((await list(f.settings)).segments, []);
  await cleanup(f.settings); assert.equal(fs.existsSync(f.piece), false);
});
