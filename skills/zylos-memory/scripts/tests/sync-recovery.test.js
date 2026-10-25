import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { memoryScope, markerPath } from '../sync-lock.js';
import { renderStateSkeleton } from '../state-format.js';
import { cleanup, list, commit } from '../sync-files.js';
const token = 'a'.repeat(32), segment = '20261019T053002123Z';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p07-crash-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const { db, store } = storeFixture(t, {}, path.join(root, 'comm-bridge', 'c4.db'));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'crash-test', ZYLOS_SESSION_GROUP: 'origin' };
  const scope = await memoryScope(env);
  fs.mkdirSync(scope.runDir, { recursive: true }); fs.mkdirSync(scope.memoryDir, { recursive: true });
  fs.writeFileSync(markerPath(scope.runDir, 'group'), JSON.stringify({ kind: 'group', token, runId: env.ZYLOS_RUN_ID, startedAt: Date.now(), expiresAt: Date.now() + 1800000 }));
  const original = renderStateSkeleton({ scope: 'origin', syncedAt: '2026-10-19T00:00:00Z' });
  const state = path.join(scope.memoryDir, 'state.md'), temporary = `${state}.${token}.tmp`, piece = path.join(scope.memoryDir, `inbox.${segment}.md`);
  fs.writeFileSync(state, original); fs.writeFileSync(piece, 'commitment: keep this');
  fs.writeFileSync(temporary, original.replace('coverage= ', 'coverage=2 ').replace('inbox_committed= ', `inbox_committed=${segment} `).replace('## Headline\n', '## Headline\nRecovered\n'));
  db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(1,'in','system','one','delivered','origin'),(2,'in','system','two','delivered','origin')").run();
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, env, state, temporary, piece, original, db, store, settings: { token, env }, deps: { currentRunId: async () => env.ZYLOS_RUN_ID } };
}
async function killAt(t, f, phase, end) {
  const worker = fileURLToPath(new URL('./fixtures/sync-crash-worker.js', import.meta.url));
  const child = spawn(process.execPath, [worker, phase, String(end), token], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  const stage = await Promise.race([once(child.stdout, 'data').then(([data]) => String(data).trim()), closed.then(() => { throw new Error(`Worker exited before crash barrier: ${errors}`); })]);
  child.kill('SIGKILL'); await closed;
  assert.equal(child.signalCode, 'SIGKILL');
  return stage;
}
test('DM39 two real checkpoint-before-rename crashes retain inputs and both delta summaries', async t => {
  const f = await fixture(t);
  for (const end of [1, 2]) {
    assert.equal(await killAt(t, f, 'before-rename', end), 'checkpoint-written');
    assert.equal(fs.readFileSync(f.state, 'utf8'), f.original);
    assert.equal(fs.existsSync(f.piece), true);
    assert.deepEqual(await list(f.settings), [segment]);
  }
  assert.deepEqual(f.store.getContentCheckpointsSince('origin', 0).map(cp => cp.summary), ['summary 1', 'summary 2']);
  // Recovery only when the caller actually starts another Sync; reads above do not repair.
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.match(fs.readFileSync(f.state, 'utf8'), /Recovered/); assert.equal(fs.existsSync(f.piece), false);
});
test('DM39 real rename-before-delete crash publishes state and cleanup removes retained committed input', async t => {
  const f = await fixture(t);
  assert.equal(await killAt(t, f, 'after-rename', 2), 'state-published');
  assert.match(fs.readFileSync(f.state, 'utf8'), /Recovered/);
  assert.equal(fs.existsSync(f.piece), true); assert.deepEqual(await list(f.settings), []);
  await cleanup(f.settings, f.deps); assert.equal(fs.existsSync(f.piece), false);
});
