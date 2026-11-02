import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { withMemoryLock, memoryScope, MARKER_TTL_MS } from '../sync-lock.js';
const worker = new URL('./fixtures/memory-worker.js', import.meta.url);
const fixture = () => ({ ...process.env, ZYLOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'memory-concurrency-')), ZYLOS_RUN_ID: 'run-1', ZYLOS_SESSION_GROUP: 'lark:oc_b' });
function child(env) {
  const proc = fork(worker, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  proc.stderr.resume();
  proc.closed = once(proc, 'close');
  return proc;
}
function request(proc, message) {
  const result = once(proc, 'message'); proc.send(message); return result.then(([value]) => value);
}
async function stop(proc) { proc.kill('SIGKILL'); await proc.closed; }

// opening the inbox does not let rotation cross the write.
test('producer stopped after open excludes rotation until append closes', async () => {
  const env = fixture(); const scope = await memoryScope(env); const producer = child(env);
  try {
    assert.deepEqual(await request(producer, { op: 'append-stop' }), { opened: true });
    let rotated = false;
    await assert.rejects(withMemoryLock(scope.runDir, () => { rotated = true; }, { waitMs: 80 }), { code: 'LOCK_TIMEOUT' });
    assert.equal(rotated, false);
    const finished = once(producer, 'message'); producer.kill('SIGCONT');
    assert.deepEqual((await finished)[0], { appended: true });
    await withMemoryLock(scope.runDir, () => {
      fs.renameSync(path.join(scope.memoryDir, 'inbox.md'), path.join(scope.memoryDir, 'inbox.segment.md'));
    });
    assert.match(fs.readFileSync(path.join(scope.memoryDir, 'inbox.segment.md'), 'utf8'), /fact: opened-before-stop\n$/);
  } finally { await stop(producer); }
});

// two independent processes contend for each expired marker.
test('1000 simultaneous stale-marker takeovers admit exactly one owner', { timeout: 90000 }, async () => {
  const env = fixture(); const scope = await memoryScope(env);
  const children = [child(env), child(env)];
  try {
    for (let i = 0; i < 1000; i++) {
      await withMemoryLock(scope.runDir, () => fs.writeFileSync(path.join(scope.runDir, 'sync.lock'), JSON.stringify({
        runId: 'run-1', kind: 'group', token: '0'.repeat(32), startedAt: 0, expiresAt: MARKER_TTL_MS,
      })));
      const results = await Promise.all(children.map(proc => request(proc, { op: 'acquire' })));
      assert.equal(results.filter(x => x.token).length, 1, `round ${i}`);
      assert.equal(results.filter(x => x.code === 'SYNC_BUSY').length, 1, `round ${i}`);
      const token = results.find(x => x.token).token;
      assert.equal(JSON.parse(fs.readFileSync(path.join(scope.runDir, 'sync.lock'))).token, token);
    }
  } finally { await Promise.all(children.map(stop)); }
});

// actual append and rename in separate processes share the fixed inode.
test('two producers append 1000 records each with a 10ms rotating consumer', { timeout: 90000 }, async () => {
  const env = fixture(); const scope = await memoryScope(env);
  const children = [child(env), child(env), child(env)];
  try {
    const rotation = request(children[2], { op: 'rotate' });
    const results = await Promise.all(children.slice(0, 2).map((proc, i) => request(proc, { op: 'append', prefix: `p${i}` })));
    assert.deepEqual(results, [{ count: 1000 }, { count: 1000 }]);
    children[2].send({ op: 'stop-rotation' });
    const rotated = await rotation;
    assert.ok(rotated.rotations > 0);
    const records = fs.readdirSync(scope.memoryDir).filter(name => /^inbox(?:\..+)?\.md$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(scope.memoryDir, name), 'utf8').split('\n').filter(line => line.startsWith('- ')));
    assert.equal(records.length, 2000);
    const ids = records.map(line => line.match(/fact: (p[01]-\d+)$/)?.[1]);
    assert.equal(new Set(ids).size, 2000);
    for (let i = 0; i < 1000; i++) for (let p = 0; p < 2; p++) assert.ok(ids.includes(`p${p}-${i}`));
  } finally { await Promise.all(children.map(stop)); }
});
