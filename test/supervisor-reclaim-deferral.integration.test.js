import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle } from '../skills/activity-monitor/scripts/supervisor-lifecycle.js';
import { SessionActivity } from '../skills/activity-monitor/scripts/session-activity.js';

// Covers the public deferral CLI through its actual socket client. Run when
// command parsing or supervisor reply shapes change; unrelated prompts may skip.
// All paths and the one private socket stay under a temporary test root; no
// tmux, PM2, database or live supervisor is contacted.
test('deferral command reports ok true without requiring the optional json flag', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const net = await import('node:net'); const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defer-cli-'));
  const directory = path.join(root, 'activity-monitor'); fs.mkdirSync(directory);
  const socketPath = path.join(directory, 'am.sock');
  const sockets = new Set();
  let child, closed;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', bytes => {
      const request = JSON.parse(bytes.toString());
      assert.equal(request.type, 'defer_reclaim'); assert.equal(request.minutes, 2); assert.equal(request.reason, 'background watcher');
      socket.end(JSON.stringify({ version: 1, type: request.type, requestId: request.requestId,
        ok: true, result: 'accepted', deferUntil: 2000000 }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    if (child?.exitCode === null) child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    if (closed) await closed.catch(() => {});
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = fileURLToPath(new URL('../skills/activity-monitor/scripts/supervisor-request.js', import.meta.url));
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), TMPDIR: root,
    TMUX_TMPDIR: root, TMUX: `${path.join(root, 'private.sock')},0,0`, ZYLOS_SESSION_GROUP: 'telegram:a', ZYLOS_RUN_ID: 'run-a' };
  console.log('Deferral CLI isolation:', JSON.stringify({ root, socketPath, args: [script, 'defer-reclaim', '--minutes', '2', '--reason', 'background watcher'],
    env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(key => [key, env[key]])) }));
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key] === root || env[key].startsWith(root + path.sep));
  child = spawn(process.execPath, [script, 'defer-reclaim', '--minutes', '2', '--reason', 'background watcher'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  let output = '', stderr = '';
  child.stdout.on('data', bytes => { output += bytes; if (output.length > 16384) child.kill('SIGKILL'); });
  child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 16384) child.kill('SIGKILL'); });
  closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const status = await closed;
  assert.equal(status, 0, stderr); assert.equal(JSON.parse(output).ok, true);
});

// Boundary: real transcript sampling composed with lifecycle deferral. Run when
// wake detection or transcript activity changes; unrelated request parsing may
// skip. Private files, in-memory DB/transport and injected clock avoid live
// tmux/PM2/network; the official runner isolates every runtime path.
test('transcript updates after deferred quiet cancel reclaim and reset the idle interval', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 2000000;
  const scene = { sessionGroup: 'a', runId: 'run-a', sessionId: 'session-1', runtime: 'claude',
    present: true, ready: true, processRunning: true, createdAt: 0, runDir: root,
    launchConfig: { runtime: 'claude', mode: 'default' } };
  const controls = [], fences = [];
  const context = { configuration: { mode: 'multi' }, scenes: [scene], fences, restartRequests: [] };
  const db = { getModeTransition: () => null, listDrainFences: () => fences,
    getLastActivity: () => ({ ts: 0 }), getUnsummarizedRange: () => ({ count: 0 }),
    resolveSessionLaunchConfig: () => scene.launchConfig,
    getControlById: id => controls.find(row => row.id === id),
    insertControl: (content, options) => { const row = { id: controls.length + 1, status: 'pending', content, ...options }; controls.push(row); return row; },
    setDrainFence: (group, fence) => fences.push({ sessionGroup: group, ...fence }) };
  const lifecycle = new SupervisorLifecycle({ db, observeGroup: () => scene, requests: { read: () => [] },
    readSyncMarker: () => ({ held: false, stale: false }), bindTarget: () => ({ expectedRunId: scene.runId }),
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check' } }, { now: () => now });
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n'); fs.utimesSync(transcript, 0, 0);
  const activity = new SessionActivity({ runDir: root, runId: 'run-a', sessionId: 'session-1', runtime: 'claude' });
  t.after(() => activity.close());
  activity.associateTranscript({ event: 'session_start', transcript_path: transcript });
  Object.assign(scene, activity.read(now - 5000));
  await lifecycle.checkTtl(scene, context);
  assert.equal((await lifecycle.deferReclaim({ sessionGroup: 'a', expectedRunId: 'run-a', minutes: 1, reason: 'background watcher' }, context)).ok, true);
  for (const control of controls) control.status = 'done';
  Object.assign(scene, activity.read(now)); await lifecycle.checkTtl(scene, context);
  assert.equal(lifecycle.ttlPreparation.get('a').defer.quietAt, now);
  now += 1000;
  fs.appendFileSync(transcript, '{}\n'); fs.utimesSync(transcript, now / 1000, now / 1000);
  Object.assign(scene, activity.read(now)); assert.equal(scene.lastActivityAt, now);
  await lifecycle.checkTtl(scene, context);
  assert.equal(lifecycle.ttlPreparation.has('a'), false);
  assert.equal(lifecycle.ttlReset.get('a').at, now); assert.equal(fences.length, 0);
});
