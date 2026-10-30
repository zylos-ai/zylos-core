import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readyTmuxTarget } from '../../../test/helpers/ready-tmux-target.js';
import { seedCodexTrustFixture } from '../../../test/helpers/codex-trust.js';
import { runtimeCommand, executeRuntimeSwitch } from '../../commands/runtime.js';
import { getSessionAdapter } from '../runtime/index.js';
import { updateZylosConfigLocked } from '../config.js';
import { submit } from '../am-sock-client.js';
import { supervisorDiagnosticPath } from '../session-group-paths.js';
import { startSupervisor } from '../../../skills/activity-monitor/scripts/supervisor-main.js';
import { SupervisorScenes } from '../../../skills/activity-monitor/scripts/supervisor-scenes.js';
import { createStore } from '../../../skills/comm-bridge/scripts/c4-v2-store.js';
import { createRouter } from '../../../skills/comm-bridge/scripts/router/scheduler.js';

async function startReplacement(t, f, db, scenes) {
  seedCodexTrustFixture({ root: f.root, home: f.root });
  const executable = path.join(f.root, 'record-runtime.mjs');
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-fixture'); process.exit(0); }
if (process.argv[2] === 'app-server') process.exit(2);
if (process.argv.includes('--help')) { console.log(' --no-daemon '); process.exit(0); }
const root = process.env.ZYLOS_DIR;
const record = { runId: process.env.ZYLOS_RUN_ID, group: process.env.ZYLOS_SESSION_GROUP ?? null,
  config: JSON.parse(process.env.ZYLOS_MODEL_CONFIG) };
fs.writeFileSync(path.join(root, 'replacement.json'), JSON.stringify(record));
const dir = path.join(root, 'activity-monitor/session-groups/origin');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'current-session.json'), JSON.stringify({
  runId: record.runId, sessionId: 'replacement-session', ts: Date.now(), startupControlIds: [] }));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  let clock = Date.now();
  const events = [], launches = [];
  const router = createRouter({ db: { ...db,
    getControlById: id => f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
    expireTimedOutControls: () => 0, cleanupControlQueue: () => 0 },
    now: () => clock, readSessionMode: () => ({ mode: 'single', keyPresent: true }),
    readLiveIdentity: group => scenes.readIdentity(group), readCurrentSession: scenes.readReady,
    listGroupTmuxSessions: () => assert.fail('single does not list groups'),
    readRuntimeHealth: () => ({ health: 'ok', publicHealth: 'ok' }),
    getSessionAdapter: runtime => {
      const adapter = getSessionAdapter(runtime, { root: f.root, env: f.env,
        tmux: { binary: f.binary, socketPath: f.socketPath, configFile: '/dev/null' },
        runtimeExecutable: () => executable });
      const launch = adapter.launch.bind(adapter);
      adapter.launch = async input => { launches.push(input); return launch(input); };
      return adapter;
    },
    submit: () => assert.fail('single activation must not submit start_attempt'),
    deliverControl: () => assert.fail('fixture has no pending controls'),
    deliverConversation: () => assert.fail('fixture has no pending conversations'),
    handleExpired: () => assert.fail('fixture has no expired conversation'),
    prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
    diagnostic: (event, fields) => events.push({ event, ...fields }),
  }, { poolSize: 1, readyTimeoutMs: 10000 });
  t.after(() => router.stop());
  await router.initialize(); await router.idle();
  for (let n = 0; n < 100; n++) {
    if (n < 7) clock += 1000;
    router.tick(); await router.idle(); await router.idle();
    if ((await scenes.readIdentity(null)).ready) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const live = await scenes.readIdentity(null);
  assert.equal(live.ready, true, JSON.stringify({ events, launches }));
  assert.equal(launches.length, 1);
  assert.equal(launches[0].sessionGroup, null);
  assert.equal(launches[0].sessionMode, 'single');
  assert.deepEqual(launches[0].launchConfig, { runtime: 'codex', mode: 'default' });
  const record = JSON.parse(fs.readFileSync(path.join(f.root, 'replacement.json'), 'utf8'));
  assert.equal(record.group, null);
  assert.equal(record.runId, live.runId);
  assert.deepEqual(record.config, live.launchConfig);
  router.stop(); await router.idle();
  return { live, record, events, launches };
}

// : actual supervisor admission/lifecycle, C4 ledger and tmux. The named
// sleeper is a controlled runtime process; no authenticated model is used.
for (const json of [false, true]) {
  test(`single ${json ? 'JSON' : 'text'} stops before ledger settlement and restarts on the new baseline`, { timeout: 30000 }, async t => {
    const f = readyTmuxTarget(t, { prefix: 'rt-m4-', mode: 'single', runtimeProcess: true });
    f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
    const configFile = path.join(f.root, '.zylos/config.json');
    const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const db = createStore(f.db, { readConfig: () => ({ state: 'ok', config: readConfig() }) });
    const conversation = db.insertConversation('in', 'system', 'runtime-switch-test', 'An unfinished conversation');
    assert.equal(db.claimConversation(conversation.id), true);
    assert.equal(db.countGlobalRunningConversations(), 1);
    const scenes = new SupervisorScenes({ env: f.env,
      connectionOptions: { socketPath: f.socketPath, binary: f.binary },
      readMode: () => ({ mode: 'single' }),
      readActivity: () => ({ state: 'busy', idleSince: null }), readUsage: () => null });
    const logs = [];
    const diagnostics = () => {
      let source;
      try { source = fs.readFileSync(supervisorDiagnosticPath(f.env), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    };
    const service = await startSupervisor({ env: f.env, db: { ...db, getDb: () => f.db }, scenes,
      readMode: () => ({ mode: 'single' }),
      readConfiguration: () => ({ ...readConfig(), mode: 'single' }),
      readSyncMarker: () => ({ held: false, stale: false }),
      machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} },
      sendAlert: () => { throw new Error('External alerts are forbidden in this fixture'); },
      log: entry => logs.push(entry), loopOptions: { schedule: () => 1, cancel() {} } });
    t.after(() => service.stop());
    const old = await scenes.readIdentity(null);
    assert.equal(old.runId, 'run-1');
    assert.equal(old.runtime, 'claude');
    assert.equal(old.ready, true);
    const requests = [], stdout = [], stderr = [];
    const originalLog = console.log, originalError = console.error, previousExit = process.exitCode;
    let result;
    try {
      console.log = (...args) => stdout.push(args.join(' '));
      console.error = (...args) => stderr.push(args.join(' '));
      process.exitCode = 0;
      result = await runtimeCommand(['codex', '--no-validate', ...(json ? ['--json'] : [])], {
        execute: (target, flags) => executeRuntimeSwitch(target, flags, {
          read: () => ({ state: 'ok', config: readConfig() }), exists: () => true,
          hooksReady: () => ({ ready: true }), identity: group => scenes.readIdentity(group),
          write: update => updateZylosConfigLocked(update, { configFile, lockFile: `${configFile}.lock` }),
          send: (request, options) => {
            requests.push(request);
            return submit(request, { ...options, socketPath: path.join(f.root, 'activity-monitor/am.sock') });
          },
        }),
      });
      assert.equal(process.exitCode, 0);
    } finally { console.log = originalLog; console.error = originalError; process.exitCode = previousExit; }
    assert.equal(result.ok, true);
    assert.equal(result.data.result, 'saved');
    assert.equal(result.data.groups[0].status, 'pending_reclaim');
    assert.equal(result.data.reclaim.result, 'accepted');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].expectedRunId, old.runId);
    assert.equal(Object.hasOwn(requests[0], 'expectedSessionId'), false);
    if (json) { assert.equal(stdout.length, 1); assert.deepEqual(JSON.parse(stdout[0]), result); }
    else assert.match(stdout.join('\n'), /pending reclaim \(the old session will be stopped and restarted with the new baseline; the current conversation will be interrupted; command does not wait\)/);
    const admitted = service.supervisor.admission.readRequests();
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].mode, 'single');
    assert.equal(admitted[0].expectedRunId, old.runId);
    assert.match(admitted[0].requestId, /^cli-rt-/);
    assert.equal(Object.hasOwn(admitted[0], 'expectedSessionId'), false);
    // : stop first, retain the fence/request until the pre-fence
    // conversation settles. Completing it early would hide reversed ordering.
    await service.supervisor.loop.tick();
    const afterTick = await scenes.readIdentity(null);
    const evidence = { output: json ? 'json' : 'text', requests, stdout, stderr,
      before: old, afterTick, runningConversations: db.countGlobalRunningConversations(),
      conversation: f.db.prepare('SELECT id,status FROM conversations WHERE id=?').get(conversation.id),
      fences: db.listDrainFences(), pending: service.supervisor.admission.readRequests(), logs,
      diagnostics: diagnostics() };
    if (process.env.SINGLE_MODE_SUPERVISOR_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.SINGLE_MODE_SUPERVISOR_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.SINGLE_MODE_SUPERVISOR_EVIDENCE_DIR, `${json ? 'json' : 'text'}-before-conversation-end.json`), JSON.stringify(evidence, null, 2) + '\n');
    }
    assert.equal(evidence.runningConversations, 1);
    assert.equal(evidence.conversation.status, 'running');
    assert.equal(afterTick.present, false, ' xv(a): supervisor stops the old session while its claimed conversation is still running');
    assert.equal(evidence.pending.length, 1);
    assert.equal(evidence.pending[0].requestId, requests[0].requestId);
    assert.equal(evidence.fences.length, 1);
    assert.equal(evidence.fences[0].sessionGroup, '*');
    assert.equal(evidence.fences[0].reason, 'manual_restart');
    assert.equal(evidence.fences[0].runId, old.runId);
    assert.equal(evidence.diagnostics.some(entry => entry.event === 'manual_restart_done'), false);
    assert.equal(db.markDelivered(conversation.id, { sessionId: old.sessionId }), true);
    await service.supervisor.loop.tick();
    assert.equal((await scenes.readIdentity(null)).present, false);
    assert.deepEqual(service.supervisor.admission.readRequests(), []);
    assert.deepEqual(db.listDrainFences(), []);
    const done = diagnostics().filter(entry => entry.event === 'manual_restart_done');
    assert.equal(done.length, 1);
    assert.equal(done[0].requestId, requests[0].requestId);
    assert.equal(done[0].run_id, old.runId);
    const replacement = await startReplacement(t, f, db, scenes);
    assert.notEqual(replacement.live.runId, old.runId);
    assert.equal(replacement.live.runtime, 'codex');
    assert.deepEqual(replacement.live.launchConfig, { runtime: 'codex', mode: 'default' });
    if (process.env.SINGLE_MODE_SUPERVISOR_EVIDENCE_DIR) {
      fs.writeFileSync(path.join(process.env.SINGLE_MODE_SUPERVISOR_EVIDENCE_DIR, `${json ? 'json' : 'text'}-completed.json`),
        JSON.stringify({ ...evidence, done, replacement, pendingAfter: service.supervisor.admission.readRequests(),
          fencesAfter: db.listDrainFences() }, null, 2) + '\n');
    }
  });
}
