import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fixture } from './c4-v2-test-helpers.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';

const worker = fileURLToPath(new URL('./helpers/router-crash-worker.js', import.meta.url));
const boundaries = ['claimed', 'reserved', 'old-controls-expired', 'scene-created', 'ready-published', 'startup-controls-delivered', 'business-pasted'];

function startWorker(directory, phase, boundary) {
  const child = spawn(process.execPath, [worker, directory, phase, boundary], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  return { child, exited, stderr: () => stderr };
}
async function deadline(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), 10000); })]);
  } finally { clearTimeout(timer); }
}
async function waitBarrier(filename, processState) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(filename)) {
    assert.equal(processState.child.exitCode, null, processState.stderr());
    assert.equal(processState.child.signalCode, null, processState.stderr());
    assert.ok(Date.now() < deadline, `worker failed to reach barrier: ${processState.stderr()}`);
    await delay(5);
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

for (const boundary of boundaries) {
  test(`process SIGKILL and restart after ${boundary}`, { timeout: 15000 }, async t => {
    const now = 1800000000000;
    const f = fixture(t, { now: () => now }, true);
    const directory = path.dirname(f.filename);
    const row = f.store.insertConversation('in', 'a', 'endpoint', 'body');
    f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(now / 1000, row.id);
    const origin = { present: true, ready: true, tmuxName: tmuxNameForGroup('origin'), runtime: 'claude',
      runId: 'origin-run', sessionId: 'origin-session', createdAt: now / 1000,
      current: { runId: 'origin-run', sessionId: 'origin-session', startupControlIds: [] } };
    fs.writeFileSync(path.join(directory, 'scene.json'), JSON.stringify({ origin }));
    const children = [];
    // Ensure child cleanup precedes the fixture's database/directory cleanup.
    try {
      const crashed = startWorker(directory, 'crash', boundary); children.push(crashed);
      assert.deepEqual(await waitBarrier(path.join(directory, 'barrier.json'), crashed), { name: boundary, pid: crashed.child.pid });
      assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status, 'running');
      assert.equal(crashed.child.kill('SIGKILL'), true);
      assert.deepEqual(await crashed.exited, [null, 'SIGKILL']);
      const before = JSON.parse(fs.readFileSync(path.join(directory, 'scene.json'), 'utf8'));
      const restarted = startWorker(directory, 'restart', boundary); children.push(restarted);
      const initialized = await deadline(Promise.race([
        once(restarted.child, 'message').then(([message]) => message),
        restarted.exited.then(result => { throw Error(`restart exited ${result}: ${restarted.stderr()}`); }),
      ]), 'restart initialization');
      assert.equal(initialized.initialized, true);
      const recovered = f.db.prepare('SELECT status,retry_count FROM conversations WHERE id=?').get(row.id);
      assert.deepEqual(recovered, { status: 'pending', retry_count: 1 });
      restarted.child.send({ continue: true });
      assert.deepEqual(await deadline(restarted.exited, 'restart delivery'), [0, null], restarted.stderr());
      const final = f.db.prepare('SELECT status,retry_count,session_id FROM conversations WHERE id=?').get(row.id);
      const scene = JSON.parse(fs.readFileSync(path.join(directory, 'scene.json'), 'utf8'));
      assert.deepEqual(final, { status: 'delivered', retry_count: 1, session_id: scene.a.sessionId });
      const events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.filter(x => x.event === 'recover' && x.phase === 'crash').length, 1);
      assert.equal(events.filter(x => x.event === 'recover' && x.phase === 'restart').length, 1);
      assert.equal(events.some(x => ['duplicate-launch', 'unexpected-stop'].includes(x.event)), false);
      assert.equal(events.filter(x => x.event === 'launch').length, 1, 'existing scene is never launched twice');
      if (before.a) assert.equal(scene.a.runId, before.a.runId, 'restart adopts the persisted run');
      const ready = events.find(x => x.event === 'ready');
      assert.ok(ready);
      const recoveryIndex = events.findIndex(x => x.event === 'control' && x.id === ready.recoveryId);
      const promptIndex = events.findIndex(x => x.event === 'control' && x.id === ready.promptId);
      const pasteIndexes = events.flatMap((x, index) => x.event === 'paste' ? [index] : []);
      assert.ok(recoveryIndex >= 0 && promptIndex > recoveryIndex);
      assert.ok(pasteIndexes.every(index => index > promptIndex), 'all business pastes follow startup prompt');
      assert.equal(events.filter(x => x.event === 'control' && x.id === ready.promptId).length, 1);
      assert.equal(events.filter(x => x.event === 'paste' && x.phase === 'restart').length, 1);
      assert.equal(pasteIndexes.length, boundary === 'business-pasted' ? 2 : 1,
        'a crash after paste before settlement may replay; no exactly-once assertion');
      console.log(JSON.stringify({ boundary, killed: 'SIGKILL', final, launches: events.filter(x => x.event === 'launch').length,
        order: events.filter(x => ['control', 'paste'].includes(x.event)).map(x => [x.phase, x.event, x.id]) }));
    } finally {
      for (const state of children) {
        if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGKILL');
        await state.exited;
      }
    }
  });
}
