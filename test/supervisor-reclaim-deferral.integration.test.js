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
test('deferral command reports acceptance and allowed minute range as JSON', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const net = await import('node:net'); const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defer-cli-'));
  const directory = path.join(root, 'activity-monitor'); fs.mkdirSync(directory);
  const socketPath = path.join(directory, 'am.sock');
  const sockets = new Set();
  const replies = [{ ok: true, result: 'accepted', deferUntil: 2000000 },
    { ok: false, result: 'rejected', reason: 'minutes_out_of_range', maxMinutes: 1.5 }];
  let replyIndex = 0;
  let child, closed;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', bytes => {
      const request = JSON.parse(bytes.toString());
      assert.equal(request.type, 'defer_reclaim'); assert.equal(request.minutes, 2); assert.equal(request.reason, 'background watcher');
      socket.end(JSON.stringify({ version: 1, type: request.type, requestId: request.requestId,
        ...replies[replyIndex++] }) + '\n');
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
  for (const accepted of [true, false]) {
    child = spawn(process.execPath, [script, 'defer-reclaim', '--minutes', '2', '--reason', 'background watcher'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    let output = '', stderr = '';
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 16384) child.kill('SIGKILL'); });
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 16384) child.kill('SIGKILL'); });
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const status = await closed;
    assert.equal(status, accepted ? 0 : 1, stderr);
    const result = JSON.parse(output); assert.equal(result.ok, accepted);
    if (!accepted) {
      assert.equal(result.error.code, 'minutes_out_of_range'); assert.equal(result.error.maxMinutes, 1.5);
      assert.match(result.error.message, /between 1 and 1\.5/);
    }
  }
  assert.equal(replyIndex, 2);
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

// Boundary: actual supervisor entry -> installed memory-pressure reclaim callback
// -> lifecycle context. The capacity sampler is replaced to capture its callback;
// configuration parsing and callback code are real. Run when pressure-path
// configuration changes; unrelated prompts may skip. Official runner plus private
// paths isolate HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket. Scenes/DB/memory are injected,
// no tmux/PM2/network or live SQLite is used, and stop closes all owned work.
test('memory pressure reclaim reads current deferral settings independently of the ordinary round', async t => {
  let pressureReclaim;
  t.mock.module('../skills/activity-monitor/scripts/pool-capacity.js', { namedExports: {
    PoolCapacity: class {
      constructor(options) { pressureReclaim = options.reclaim; this.lastPublished = null; }
      async tick() { return null; }
    },
  } });
  const { startSupervisor } = await import('../skills/activity-monitor/scripts/supervisor-main.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pressure-config-'));
  const env = { HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), TMPDIR: root,
    TMUX_TMPDIR: root, TMUX: `${path.join(root, 'private.sock')},0,0`, PATH: process.env.PATH };
  console.log('Pressure configuration isolation:', JSON.stringify({ env, socket: path.join(root, 'activity-monitor/am.sock'), database: 'injected' }));
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key] === root || env[key].startsWith(root + path.sep));
  let service;
  t.after(async () => { try { await service?.stop(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  let raw = { session_mode: 'multi', runtime: 'claude', session_reclaim_defer_max_seconds: 60,
    session_reclaim_defer_alert_seconds: 180 };
  const db = { getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listPendingSessionGroups: () => [], getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }) };
  service = await startSupervisor({ env, db, now: () => 200000, readConfig: () => raw,
    readMode: () => ({ mode: 'multi' }), readMemoryInputs: () => assert.fail('sampler is injected'),
    scenes: { observe: async () => [], observeGroup: async () => ({ present: false }),
      listRuns: async () => [], readRun: async () => null, readIdentity: async () => ({ present: false }) },
    legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
    loopOptions: { schedule: () => 1, cancel() {} }, sendAlert: () => assert.fail('External send forbidden'), log() {},
  });
  assert.equal(service.supervisor.loop.configurationError, null);
  assert.equal(service.supervisor.loop.configuration.reclaimDeferMaxSeconds, 60);
  assert.equal(service.supervisor.loop.configuration.reclaimDeferAlertSeconds, 180);
  assert.equal(typeof pressureReclaim, 'function');
  raw = { ...raw, session_reclaim_defer_max_seconds: 90, session_reclaim_defer_alert_seconds: 240 };
  let observed;
  service.supervisor.lifecycle.checkCapacityPressure = async context => { observed = context.configuration; return null; };
  await pressureReclaim();
  assert.ok(observed, 'the actual registered pressure callback reaches lifecycle');
  assert.equal(observed.reclaimDeferMaxSeconds, 90);
  assert.equal(observed.reclaimDeferAlertSeconds, 240);
  assert.equal(service.supervisor.loop.configuration.reclaimDeferMaxSeconds, 60, 'no ordinary configuration refresh happened');
});
