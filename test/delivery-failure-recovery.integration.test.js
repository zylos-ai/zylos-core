import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';

// The runner's environment is shared by concurrent files. Allocate this file's
// config, socket and database before any product module captures its paths.
const inheritedRoot = process.env.ZYLOS_DIR;
assert.ok(inheritedRoot && process.env.TMPDIR, 'use the official isolated Node runner');
const privateRoot = fs.mkdtempSync(path.join(process.env.TMPDIR, 'dr-'));
process.env.HOME = path.join(privateRoot, 'h');
process.env.ZYLOS_DIR = path.join(privateRoot, 'z');
process.env.PM2_HOME = path.join(privateRoot, 'p');
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) fs.mkdirSync(process.env[key]);
after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));

const database = await import('../skills/comm-bridge/scripts/c4-db.js');
const { createDispatcher } = await import('../skills/comm-bridge/scripts/router/factory.js');
const { createSupervisor } = await import('../skills/activity-monitor/scripts/supervisor.js');
const { RestartRequestStore } = await import('../skills/activity-monitor/scripts/restart-request-store.js');
const { ACTIVITY_MONITOR_DIR } = await import('../skills/comm-bridge/scripts/c4-config.js');
const { CONFIG_FILE, SKILLS_DIR } = await import('../cli/lib/config.js');
assert.notEqual(process.env.ZYLOS_DIR, inheritedRoot);
assert.equal(CONFIG_FILE, path.join(privateRoot, 'z', '.zylos', 'config.json'));
assert.equal(ACTIVITY_MONITOR_DIR, path.join(privateRoot, 'z', 'activity-monitor'));
assert.ok(Buffer.byteLength(path.join(ACTIVITY_MONITOR_DIR, 'am.sock')) < 104);

// Boundary: real factory defaults -> terminal ledger write -> notification IPC
// -> assembled Supervisor -> activity/fence gates -> existing stop path. Run
// for delivery recovery or its wiring; unrelated changes may skip. Official
// runner isolates short TMPDIR; this file owns HOME/ZYLOS_DIR/PM2_HOME beneath
// it, independently of every concurrent test file. Only private SQLite and
// Unix sockets are used; terminal/process boundaries are injected (no tmux/PM2).
// Server, clients, dispatcher and Supervisor are drained on failure and timeout.
for (const [mode, maintenance] of [['single', null], ['single', 'memory_sync'],
  ['single', 'session_switch'], ['multi', null]]) {
  test(`${mode} terminal delivery recovery respects ${maintenance ?? 'open admission'}`, { timeout: 8000 }, async t => {
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
      assert.ok(process.env[key]);
      assert.ok(path.resolve(process.env[key]).startsWith('/private/tmp/') || path.resolve(process.env[key]).startsWith('/tmp/'));
    }
    const root = process.env.ZYLOS_DIR, group = mode === 'single' ? null : 'origin';
    const runDir = path.join(root, 'fixture-run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(SKILLS_DIR, 'dashboard'), { recursive: true });
    fs.mkdirSync(ACTIVITY_MONITOR_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ runtime: 'codex', session_mode: mode }));
    let clock = Date.now(), stops = 0, pastes = 0, syncReads = 0, switchReads = 0;
    const live = { sessionGroup: group, present: true, ready: true, runtime: 'codex',
      runId: 'silent-run', sessionId: 'runtime-session', runDir, currentSessionTs: clock - 10000 };
    const scenes = {
      readRun: async scope => { assert.equal(scope, group); return { ...live }; },
      readIdentity: async scope => ({ ...live, sessionGroup: scope }),
      observe: async () => [{ ...live, sessionGroup: 'origin' }],
      listRuns: async () => [],
      stop: async scene => { assert.equal(scene.sessionGroup, 'origin'); assert.equal(scene.runId, live.runId); stops++; },
    };
    // Keep real requireGroup validation at both observer and stop admission.
    const db = { ...database, latestSessionSwitchAt: () => { switchReads++; return maintenance === 'session_switch' ? Math.floor(clock / 1000) : null; } };
    const supervisor = createSupervisor({ db, scenes, zylosDir: root, env: process.env,
      readConfiguration: async () => ({ mode, runtime: 'codex', capacity: 1 }), readMode: () => ({ mode }),
      resolveTargetRuntime: async () => 'codex', now: () => clock,
      requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
      readSyncMarker: async () => { syncReads++; return { held: maintenance === 'memory_sync' }; },
      loopOptions: { schedule: () => 1, cancel() {} }, log() {},
    });
    supervisor.admission.openEntry();
    const sockets = new Set(), received = [], replies = [];
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      let input = '';
      socket.on('data', data => {
        input += data;
        if (input.length > 8192) socket.destroy();
        else if (input.includes('\n')) received.push(JSON.parse(input.slice(0, input.indexOf('\n'))));
      });
      const end = socket.end.bind(socket);
      socket.end = (data, ...args) => { if (typeof data === 'string') replies.push(JSON.parse(data)); return end(data, ...args); };
      supervisor.connectionHandler(socket);
    });
    let dispatcher;
    t.after(async () => {
      await dispatcher?.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await supervisor.stop(); database.close();
    });
    const socketPath = path.join(ACTIVITY_MONITOR_DIR, 'am.sock');
    t.diagnostic(JSON.stringify({ uid: process.getuid?.(), HOME: process.env.HOME, ZYLOS_DIR: root,
      PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socketPath, database: path.join(root, 'comm-bridge', 'c4.db'), tmux: 'unused' }));
    server.listen(socketPath); await once(server, 'listening');
    const target = { ...live, runtimeSessionId: live.sessionId, sessionId: '$1', serverGeneration: '1:1', paneId: '%1' };
    dispatcher = createDispatcher({ env: process.env, db, now: () => clock, log() {},
      diagnostics: { diagnostic() {}, maintain() {} },
      listGroupTmuxSessions: async () => [{ ...live, sessionGroup: 'origin' }],
      readLiveIdentities: async groups => new Map(groups.map(scope => [scope, live])), readLiveIdentity: async () => live,
      readCurrentSession: async () => ({ runId: live.runId, sessionId: live.sessionId, startupControlIds: [] }),
      readSessionState: async () => ({ identity: live, status: { valid: true, value: { state: 'idle', health: 'ok', idle_seconds: 4, proc: { alive: true } } } }),
      readRuntimeHealth: () => ({ missing: true }),
      openTmuxConnection: async () => ({ command: async args => args.at(-1) === '#{cursor_x}' ? '2' : '0', close: async () => {} }),
      resolveSessionTarget: async () => target, revalidateSessionTarget: async () => {},
      getSessionAdapter: () => ({ sendText: async () => { pastes++; }, sendKeys: async () => { throw Object.assign(new Error('unverified'), { code: 'ENTER_UNVERIFIED' }); },
        captureScreen: async () => 'prompt', launch: async () => assert.fail('run already READY') }),
      sleep: async ms => { clock += ms; },
      findLegacySessions: async () => [], advanceLegacy: async () => {}, prepareSingle: async () => {},
      submit: async () => assert.fail('run already READY'),
    }, { delivery: { periodicEnabled: false, retryBaseMs: 1, verifyWaitMs: 1 } });
    const row = database.insertConversation('in', 'dashboard', 'origin', 'hello');
    await dispatcher.initialize(); await dispatcher.idle();
    for (let round = 0; round < 3; round++) { dispatcher.tick(); await dispatcher.idle(); }
    const settled = database.getDb().prepare('SELECT status,retry_count FROM conversations WHERE id=?').get(row.id);
    assert.equal(settled.status, 'failed'); assert.equal(settled.retry_count, 2); assert.equal(pastes, 2);
    // Notification is best effort; wait only for bounded actual socket handling,
    // including the refusal path, rather than assuming idle() drained its hint.
    for (let round = 0; round < 200 && !received.some(event => event.type === 'notify_delivery_failed'); round++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await supervisor.connectionHandler.drain();
    const facts = received.filter(event => event.type === 'notify_delivery_failed');
    assert.equal(facts.length, 1, 'factory default failure notifier is connected');
    assert.equal(facts[0].sessionGroup, group);
    assert.equal(replies.some(reply => reply.code === 'invalid_request'), false);
    assert.equal(stops, maintenance ? 0 : 1, 'Supervisor default failure callback reaches the existing stop path');
    if (mode === 'single') assert.ok(syncReads > 0);
    if (maintenance === 'session_switch') assert.ok(switchReads > 0);
  });
}
