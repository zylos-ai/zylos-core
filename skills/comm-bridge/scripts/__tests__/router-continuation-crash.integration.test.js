import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fixture } from './c4-v2-test-helpers.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';

const worker = fileURLToPath(new URL('./helpers/router-continuation-crash-worker.js', import.meta.url));
function start(directory, phase, boundary, env, signal) {
  const child = spawn(process.execPath, [worker, directory, phase, boundary], { env, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { stderr += `${error.name}: ${error.message}`; });
  return { child, exited: new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal]))), stderr: () => stderr };
}
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('worker deadline exceeded')), 10000); })]); }
  finally { clearTimeout(timer); }
}

for (const boundary of ['before-launch', 'before-ready']) {
  // Coverage: real Router process death after reservation/before launch and after
  // scene creation/before READY. Run when activation/restart/control preservation
  // changes; skip for unrelated presentation changes. Only run in isolation,
  // never against live resources: private HOME, ZYLOS_DIR, PM2_HOME, short
  // TMPDIR, private tmux socket and test database. No runtime or tmux is run.
  test(`continuation SIGKILL and restart at ${boundary}`, { timeout: 15000 }, async t => {
    const now = 1800000000000;
    const f = fixture(t, { now: () => now }, true), directory = path.dirname(f.filename);
    const seed = f.store.insertConversation('in', 'a', 'endpoint', 'finished seed');
    f.db.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(seed.id);
    const id = f.store.recordRunEnd('a', { runId: 'old-run', reason: 'unexpected' }).continuationControlId;
    const origin = { present: true, ready: true, tmuxName: tmuxNameForGroup('origin'), runtime: 'claude',
      runId: 'origin-run', sessionId: 'origin-session', createdAt: now / 1000,
      current: { runId: 'origin-run', sessionId: 'origin-session', startupControlIds: [] } };
    fs.writeFileSync(path.join(directory, 'scene.json'), JSON.stringify({ origin }));
    const env = { ...process.env, HOME: path.join(directory, 'home'), ZYLOS_DIR: path.join(directory, 'home', 'zylos'),
      PM2_HOME: path.join(directory, 'pm2'), TMPDIR: path.join(directory, 'tmp'), TMUX_TMPDIR: path.join(directory, 'tmux') };
    delete env.TMUX;
    for (const name of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR']) fs.mkdirSync(env[name], { recursive: true });
    t.diagnostic(JSON.stringify({ worker, boundary, database: f.filename, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, tmuxInvoked: false }));
    const children = [];
    try {
      const crashed = start(directory, 'crash', boundary, env, t.signal); children.push(crashed);
      await deadline((async () => { while (!fs.existsSync(path.join(directory, 'barrier.json'))) {
        assert.equal(crashed.child.exitCode, null, crashed.stderr());
        assert.equal(crashed.child.signalCode, null, crashed.stderr()); await delay(5);
      } })());
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'barrier.json'), 'utf8')), { name: boundary, pid: crashed.child.pid });
      assert.equal(f.db.prepare('SELECT status FROM control_queue WHERE id=?').get(id).status, 'pending');
      assert.equal(crashed.child.kill('SIGKILL'), true); assert.deepEqual(await crashed.exited, [null, 'SIGKILL']);
      const before = JSON.parse(fs.readFileSync(path.join(directory, 'scene.json'), 'utf8'));
      const restarted = start(directory, 'restart', boundary, env, t.signal); children.push(restarted);
      assert.deepEqual(await deadline(restarted.exited), [0, null], restarted.stderr());
      const events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.filter(row => row.event === 'launch').length, 1);
      assert.equal(events.some(row => ['duplicate-launch', 'unexpected-stop'].includes(row.event)), false);
      assert.equal(events.filter(row => row.event === 'control' && row.id === id).length, 1);
      assert.equal(f.db.prepare('SELECT status FROM control_queue WHERE id=?').get(id).status, 'done');
      const prompt = events.find(row => row.event === 'ready').promptId;
      assert.ok(events.findIndex(row => row.event === 'control' && row.id === prompt) < events.findIndex(row => row.event === 'control' && row.id === id));
      const scene = JSON.parse(fs.readFileSync(path.join(directory, 'scene.json'), 'utf8'));
      if (before.a) assert.equal(scene.a.runId, before.a.runId);
    } finally {
      for (const state of children) {
        if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGKILL');
        await state.exited;
      }
    }
  });
}
