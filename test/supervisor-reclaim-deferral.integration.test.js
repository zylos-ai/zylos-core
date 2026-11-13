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
test('deferral command reports reason-only acceptance and refusal as JSON', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const net = await import('node:net'); const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defer-cli-'));
  const directory = path.join(root, 'activity-monitor'); fs.mkdirSync(directory);
  const socketPath = path.join(directory, 'am.sock');
  const sockets = new Set();
  const replies = [{ ok: true, result: 'accepted' },
    { ok: false, result: 'rejected', reason: 'no_preparation' }];
  let replyIndex = 0;
  let child, closed;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', bytes => {
      const request = JSON.parse(bytes.toString());
      assert.equal(request.type, 'defer_reclaim'); assert.equal(Object.hasOwn(request, 'minutes'), false); assert.equal(request.sessionGroup, 'telegram:a'); assert.equal(request.expectedRunId, 'run-a'); assert.equal(request.reason, 'background watcher');
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
  console.log('Deferral CLI isolation:', JSON.stringify({ root, socketPath, args: [script, 'defer-reclaim', '--reason', 'background watcher'],
    env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(key => [key, env[key]])) }));
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key] === root || env[key].startsWith(root + path.sep));
  for (const accepted of [true, false]) {
    child = spawn(process.execPath, [script, 'defer-reclaim', '--reason', 'background watcher'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    let output = '', stderr = '';
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 16384) child.kill('SIGKILL'); });
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 16384) child.kill('SIGKILL'); });
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const status = await closed;
    assert.equal(status, accepted ? 0 : 1, stderr);
    const result = JSON.parse(output); assert.equal(result.ok, accepted);
    if (!accepted) {
      assert.equal(result.error.code, 'no_preparation'); assert.match(result.error.message, /not accepted/i);
    }
  }
  assert.equal(replyIndex, 2);
});

// Boundary: real transcript sampling composed with lifecycle deferral. Run when
// idle reset or transcript activity changes; unrelated request parsing may
// skip. Private files, in-memory DB/transport and injected clock avoid live
// tmux/PM2/network; the official runner isolates every runtime path.
test('accepted deferral cancels immediately and real transcript updates restart the idle interval', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  console.log('Transcript isolation:', JSON.stringify({ root, HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: 'injected', transport: 'injected' }));
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
  assert.equal((await lifecycle.deferReclaim({ sessionGroup: 'a', expectedRunId: 'run-a', reason: 'background watcher' }, context)).ok, true);
  for (const control of controls) control.status = 'done';
  Object.assign(scene, activity.read(now)); await lifecycle.checkTtl(scene, context);
  assert.equal(lifecycle.ttlPreparation.has('a'), false);
  assert.equal(lifecycle.ttlReset.get('a').at, now);
  assert.equal(fences.length, 0);
  now += 1000;
  fs.appendFileSync(transcript, '{}\n'); fs.utimesSync(transcript, now / 1000, now / 1000);
  Object.assign(scene, activity.read(now)); assert.equal(scene.lastActivityAt, now);
  await lifecycle.checkTtl(scene, context);
  assert.equal(lifecycle.ttlPreparation.has('a'), false);
  assert.equal(lifecycle.ttlReset.get('a').at, now - 1000); assert.equal(fences.length, 0);
  assert.equal(lifecycle.reclaimDeferrals.get('a').count, 1);
  now += 1799999; await lifecycle.checkTtl(scene, context);
  assert.equal(controls.length, 1, 'transcript activity postpones the next idle check');
  now += 1; await lifecycle.checkTtl(scene, context);
  assert.equal(controls.length, 2);
});

// Boundary: real supervisor socket admission reads changed configuration without
// waiting for the ordinary round; the same entry receives the existing delivered
// notification. Run for request/configuration/dispatch wiring changes; prompt-only
// changes may skip. Private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket plus injected
// scenes and DB prevent contact with tmux, PM2, SQLite or a live supervisor.
test('socket requests hot-read the alert count and delivery notifications clear only the matching run', async t => {
  const { startSupervisor } = await import('../skills/activity-monitor/scripts/supervisor-main.js');
  const net = await import('node:net');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'request-config-'));
  const env = { HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), TMPDIR: root,
    TMUX_TMPDIR: root, TMUX: `${path.join(root, 'private.sock')},0,0`, PATH: process.env.PATH };
  const socketPath = path.join(root, 'activity-monitor/am.sock');
  console.log('Request configuration isolation:', JSON.stringify({ env, socket: socketPath, database: 'injected' }));
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key] === root || env[key].startsWith(root + path.sep));
  let service;
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    try { await service?.stop(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  let raw = { session_mode: 'multi', runtime: 'claude', session_reclaim_defer_alert_count: 4 };
  const run = { present: true, ready: true, runId: 'run-a', runtime: 'claude', sessionGroup: 'a' };
  const db = { getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listPendingSessionGroups: () => [], getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }) };
  service = await startSupervisor({ env, db, now: () => 200000, readConfig: () => raw,
    readMode: () => ({ mode: 'multi' }), readMemoryInputs: () => ({ totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }),
    scenes: { observe: async () => [], observeGroup: async () => ({ present: false }),
      listRuns: async () => [], readRun: async () => run, readIdentity: async () => ({ present: false }) },
    legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
    loopOptions: { schedule: () => 1, cancel() {} }, sendAlert: () => assert.fail('External send forbidden'), log() {},
  });
  assert.equal(service.supervisor.loop.configurationError, null);
  assert.equal(service.supervisor.loop.configuration.reclaimDeferAlertCount, 4);
  let sequence = 0;
  async function request(body) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath); sockets.add(socket);
      let output = '';
      socket.setTimeout(5000, () => socket.destroy(new Error('Private request timed out')));
      socket.once('connect', () => socket.write(JSON.stringify({ version: 1, requestId: `request-${++sequence}`, ...body }) + '\n'));
      socket.on('data', bytes => { output += bytes; if (output.length > 16384) socket.destroy(new Error('Reply too large')); });
      socket.once('error', reject);
      socket.once('close', () => { sockets.delete(socket); });
      socket.once('end', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    });
  }
  const counts = [];
  const defer = service.supervisor.lifecycle.deferReclaim.bind(service.supervisor.lifecycle);
  service.supervisor.lifecycle.deferReclaim = (request, context) => {
    counts.push(context.configuration.reclaimDeferAlertCount); return defer(request, context);
  };
  const body = { type: 'defer_reclaim', sessionGroup: 'a', expectedRunId: 'run-a', reason: 'background watcher' };
  assert.equal((await request(body)).reason, 'no_preparation');
  raw = { ...raw, session_reclaim_defer_alert_count: 2 };
  assert.equal((await request(body)).reason, 'no_preparation');
  assert.deepEqual(counts, [4, 2]);
  assert.equal(service.supervisor.loop.configuration.reclaimDeferAlertCount, 4, 'ordinary round has not refreshed');
  service.supervisor.lifecycle.reclaimDeferrals.set('a', { runId: 'run-a', count: 3, reasons: ['one', 'two', 'three'], alerted: false });
  const delivered = { version: 2, type: 'notify_delivered', sessionGroup: 'a', runtime: 'claude', pastedAt: 200000 };
  assert.equal((await request({ ...delivered, runId: 'stale-run' })).type, 'ack');
  assert.equal(service.supervisor.lifecycle.reclaimDeferrals.get('a').count, 3);
  assert.equal((await request({ ...delivered, runId: 'run-a' })).type, 'ack');
  assert.equal(service.supervisor.lifecycle.reclaimDeferrals.has('a'), false);
});
