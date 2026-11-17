import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const database = await import('../c4-db.js');
const { createDispatcher } = await import('../router/factory.js');
const { createStatusNoticeSender } = await import('../c4-status-notice.js');
const { messageForFailureReceipt } = await import('../failure-receipt-template.js');
const { CONFIG_FILE, SKILLS_DIR } = await import('../../../../cli/lib/config.js');
const { tmuxNameForGroup } = await import('../../../../cli/lib/session-group-paths.js');
after(() => { database.close(); environment.cleanup(); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message) { for (let i = 0; i < 2000; i++) { if (predicate()) return; await flush(); } assert.fail(typeof message === 'function' ? message() : message); }
let sequence = 0;
function configuration(mode = 'multi') {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ runtime: 'codex', session_mode: mode, statusNotices: { brand: 'Factory' } }));
}
// Factory composition boundary: run for dispatcher/slot fixture changes; skip unrelated UI.
// createTestEnvironment owns the shared SQLite root; scene/runtime I/O is injected.
// The private root has no publication, so env fixes K independently of the host.
function setup(t, { mode = 'multi', phase } = {}) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(environment.root + path.sep) ||
      (key === 'TMPDIR' && environment.root.startsWith(process.env[key] + path.sep)), `${key} must be isolated`);
  }
  const filename = database.getDb().pragma('database_list').find(row => row.name === 'main').file;
  assert.ok(filename.startsWith(environment.root + path.sep), 'SQLite must be isolated');
  configuration(mode);
  const prefix = `factory${++sequence}`, a = `${prefix}a`, b = `${prefix}b`;
  for (const name of [a,b]) fs.mkdirSync(path.join(SKILLS_DIR, name), { recursive: true });
  const calls = [], held = deferred(); let holding = false, blockedOnce = false;
  const keys = mode === 'single' ? [null] : ['origin', a, b];
  const scenes = new Map(keys.map(group => [group, { present: true, ready: true, runtime: 'codex',
    runId: `r-${group}`, sessionId: `business-${group}`, runtimeSessionId: `business-${group}`,
    tmuxName: tmuxNameForGroup(group ?? 'origin'), serverGeneration: 'test-generation', paneId: `%${group}`, createdAt: Math.floor(Date.now()/1000) }]));
  const target = group => ({ ...scenes.get(group), sessionGroup: group, sessionId: `$${group}` });
  const wait = async () => { holding = true; await held.promise; };
  database.getDb().exec('DELETE FROM slot_occupancy'); // Each fixture owns its occupancy; this file shares one database.
  const db = { ...database };
  const overrides = {
    env: { ...process.env, ZYLOS_SESSION_POOL_SIZE: '2' },
    db, diagnostics: { diagnostic: (...args) => calls.push(['event', ...args]), maintain() {} }, log: message => calls.push(['log', message]),
    listGroupTmuxSessions: async () => keys.map(sessionGroup => ({ sessionGroup, ...scenes.get(sessionGroup) })),
    readLiveIdentities: async groups => new Map(groups.map(group => [group, scenes.get(group) ?? { present: false }])),
    readLiveIdentity: async group => scenes.get(group) ?? { present: false },
    readCurrentSession: async group => { calls.push(['current', group]); return { runId: `r-${group}`, sessionId: `business-${group}`, startupControlIds: [] }; },
    readSessionState: async (group, options) => { assert.deepEqual(options, { freshnessMs: 5000 }); calls.push(['state', group]);
      return { identity: scenes.get(group), status: { valid: true, value: { state: 'idle', health: 'ok', idle_seconds: 4, proc: { alive: true } } } }; },
    readRuntimeHealth: () => ({ missing: true }),
    openTmuxConnection: async () => ({ command: async args => args.at(-1) === '#{cursor_x}' ? '2' : '0', close: async () => {} }),
    resolveSessionTarget: async ({ sessionGroup }) => { calls.push(['resolve', sessionGroup]); return target(sessionGroup); },
    revalidateSessionTarget: async () => {},
    getSessionAdapter: () => ({
      sendText: async input => { calls.push(['paste', input.target.sessionGroup, input.text]);
        if (input.target.sessionGroup === a && !blockedOnce && ['paste','backoff'].includes(phase)) {
          blockedOnce = true;
          if (phase === 'paste') await wait(); else throw Error('paste failure');
        } },
      sendKeys: async input => { calls.push(['keys', input.target.sessionGroup, input.keys]);
        if (input.target.sessionGroup === a && !blockedOnce && phase === 'enter') { blockedOnce = true; await wait(); } },
      captureScreen: async () => '❯ ',
      launch: async () => assert.fail('fixture has READY scene'), stop: async () => assert.fail('fixture has READY scene'),
    }),
    sleep: async ms => { if ((phase === 'idle' && ms === 31) || (phase === 'backoff' && ms === 37)) await wait(); },
    notifyDelivered: fields => { calls.push(['notify', fields]); },
    findLegacySessions: async () => [], advanceLegacy: async () => {}, prepareSingle: async () => {},
    submit: async () => assert.fail('READY scene needs no start_attempt'),
  };
  const options = { readyTimeoutMs: 1000,
    delivery: { periodicEnabled: false, verifyWaitMs: 1, idleHoldMs: 31, idleWaitMs: 100, idlePollMs: 1, retryBaseMs: 37 } };
  let dispatcher;
  t.after(async () => { held.resolve(); await dispatcher?.stop(); });
  return { a,b,db,calls,overrides,options,held,scenes,holding: () => holding,
    create(create = createDispatcher) { return dispatcher = create(overrides, options); },
    add(channel = a, content = 'hello', options = {}) { return db.insertConversation('in', channel, `endpoint-${channel}`, content, options); },
    row(id) { return db.getDb().prepare('SELECT * FROM conversations WHERE id=?').get(id); },
  };
}

for (const phase of ['paste','enter','idle','backoff']) test(`factory: ${phase} wait holds only its lane; real claims/settlement preserve same-group order`, async t => {
  const f = setup(t, { phase });
  const first = f.add(f.a, `first-${phase}`, { requireIdle: phase === 'idle' }), second = f.add(f.a, `second-${phase}`), other = f.add(f.b, `other-${phase}`);
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick();
  await until(() => f.holding() && f.row(other.id).status === 'delivered', () => `${phase}: other lane did not finish while first blocked ${JSON.stringify(f.calls)} state=${JSON.stringify([...dispatcher.state.live])}`);
  assert.equal(f.row(second.id).status, 'pending');
  assert.equal(f.row(first.id).status, phase === 'backoff' ? 'pending' : 'running');
  assert.equal(f.row(first.id).retry_count, phase === 'backoff' ? 1 : 0);
  for (let i = 0; i < 3; i++) { dispatcher.tick(); await flush(); }
  assert.equal(f.row(second.id).status, 'pending');
  assert.equal(f.calls.filter(c => c[0] === 'paste' && c[1] === f.a).length, 1);
  f.held.resolve(); await dispatcher.idle();
  for (let i = 0; i < 3; i++) { dispatcher.tick(); await dispatcher.idle(); }
  assert.equal(f.row(first.id).status, 'delivered'); assert.equal(f.row(second.id).status, 'delivered');
  assert.equal(f.row(first.id).session_id, `business-${f.a}`);
  assert.ok(f.calls.find(c => c[0] === 'paste' && c[1] === f.a)[2].includes('---- reply via:'));
});

test('factory: real expiry + shared sender happen post-commit, then next fresh row delivers', async t => {
  const f = setup(t), old = f.add(), fresh = f.add(f.a, 'fresh after expiry');
  f.db.getDb().prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(Math.floor(Date.now()/1000)-1801, old.id);
  const attempts = [];
  f.overrides.sendStatusNotice = createStatusNoticeSender({ db: f.db,
    render: () => assert.fail('durable failure receipt must use its metadata renderer'),
    diagnostic() {}, spawn: (_command, args) => {
      const child = new EventEmitter(); child.pid = 12; child.stdin = new EventEmitter();
      child.stdin.end = body => { assert.equal(f.row(old.id).delivery_action, 'pending_expired'); attempts.push({ args, body }); queueMicrotask(() => child.emit('close', 0, null)); };
      child.kill = () => {}; return child;
    } });
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  assert.equal(f.row(old.id).status, 'failed'); assert.equal(f.row(old.id).delivery_action, 'pending_expired');
  assert.equal(f.row(fresh.id).status, 'delivered'); assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].args.slice(1), [f.a, `endpoint-${f.a}`]);
  assert.equal(attempts[0].body, messageForFailureReceipt({ ...old, reason: 'pending_expired' }));
  assert.match(attempts[0].body, /^\[Factory\]/);
  for (let i = 0; i < 3; i++) { dispatcher.tick(); await dispatcher.idle(); }
  assert.equal(attempts.length, 1, 'persistent receipt must not be sent again');
  assert.equal(f.db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(old.id).state, 'sent');
  assert.equal(f.calls.filter(c => c[0] === 'paste').length, 1);
  assert.ok(f.db.getStatusNoticeCooldowns().some(c => c.cooldown_key.includes('pending_expired')));
});

// Durable restart boundary: run for terminal failure/outbox/factory changes; skip UI-only changes.
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and SQLite are read back by setup; terminal I/O
// is injected, so no tmux socket or external account is opened. Teardown drains all work.
test('factory: startup drains a persisted failure once without redelivering its original input', async t => {
  const f = setup(t), original = f.add(f.a, 'private original input');
  assert.equal(f.db.claimConversation(original.id), true);
  assert.equal(f.db.failDelivery(original.id, { maxRetries: 1, reason: 'launch_failed' }).status, 'failed');
  assert.equal(f.db.listFailureReceipts().some(row => row.id === original.id), true);
  const attempts = [], alerts = [];
  f.overrides.alert = (...args) => alerts.push(args);
  f.overrides.sendStatusNotice = createStatusNoticeSender({ db: f.db, diagnostic() {},
    spawn: (_command, args) => {
      const child = new EventEmitter(); child.pid = 12; child.stdin = new EventEmitter();
      child.stdin.end = body => { attempts.push({ args, body }); queueMicrotask(() => child.emit('close', 0, null)); };
      child.kill = () => {}; return child;
    } });
  const fresh = f.add(f.a, 'fresh after startup failure');
  const dispatcher = f.create();
  await dispatcher.initialize(); await dispatcher.idle();
  for (let i = 0; i < 3; i++) { dispatcher.tick(); await dispatcher.idle(); }
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].args.slice(1), [f.a, `endpoint-${f.a}`]);
  assert.equal(attempts[0].body, messageForFailureReceipt({ ...original, reason: 'launch_failed' }));
  assert.equal(attempts[0].body.includes('private original input'), false);
  assert.equal(f.row(original.id).status, 'failed');
  assert.equal(f.row(fresh.id).status, 'delivered');
  assert.equal(alerts.length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
});

test('factory: actual unreadable remains inert once, even if config repaired', async t => {
  const f = setup(t); fs.writeFileSync(CONFIG_FILE, '{broken');
  const alerts = []; f.overrides.alert = (...args) => alerts.push(args);
  f.overrides.listGroupTmuxSessions = async () => assert.fail('inert factory must not observe terminals');
  f.overrides.db = { ...f.db, recoverOrphanRunning: () => assert.fail('inert factory must not recover DB') };
  const dispatcher = f.create(); await dispatcher.initialize(); configuration('multi');
  await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  assert.equal(dispatcher.state.inert, true); assert.equal(alerts.length, 1);
});

test('factory: actual single directs a non-null group through null origin target', async t => {
  const f = setup(t, { mode: 'single' }), row = f.add();
  assert.equal(f.row(row.id).session_group, f.a);
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  assert.equal(f.row(row.id).status, 'delivered'); assert.equal(f.row(row.id).session_id, 'business-null');
  assert.deepEqual(f.calls.filter(c => c[0] === 'resolve'), [['resolve', null]]);
  assert.equal(f.calls.find(c => c[0] === 'notify')[1].sessionGroup, null);
});

test('factory: blocked paste in live A does not prevent absent B from launching and delivering', async t => {
  const f = setup(t, { phase: 'paste' }), bScene = f.scenes.get(f.b);
  f.scenes.delete(f.b);
  const originalAdapter = f.overrides.getSessionAdapter;
  const launches = [];
  f.overrides.getSessionAdapter = runtime => ({ ...originalAdapter(runtime), launch: async input => {
    launches.push(input); assert.equal(input.sessionGroup, f.b);
    f.scenes.set(f.b, { ...bScene, runId: input.runId });
  } });
  const readCurrent = f.overrides.readCurrentSession;
  f.overrides.readCurrentSession = async group => ({ ...await readCurrent(group), runId: f.scenes.get(group)?.runId });
  const first = f.add(), other = f.add(f.b);
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick();
  await until(f.holding, 'live A must reach held paste');
  await until(() => { dispatcher.tick(); return f.row(other.id).status === 'delivered'; }, 'absent B must launch and deliver while A is held');
  assert.equal(launches.length, 1); assert.equal(f.row(first.id).status, 'running');
  assert.equal(f.row(other.id).retry_count, 0);
  assert.ok(f.calls.some(c => c[0] === 'paste' && c[1] === f.b));
  f.held.resolve(); await dispatcher.idle();
  assert.equal(f.row(first.id).status, 'delivered');
});

test('factory: held launch in absent A does not block existing READY B delivery', async t => {
  const launchHold = deferred(); t.after(() => launchHold.resolve());
  const f = setup(t), aScene = f.scenes.get(f.a); let launching = false;
  f.scenes.delete(f.a);
  const originalAdapter = f.overrides.getSessionAdapter;
  f.overrides.getSessionAdapter = runtime => ({ ...originalAdapter(runtime), launch: async input => {
    assert.equal(input.sessionGroup, f.a); launching = true;
    await launchHold.promise; f.scenes.set(f.a, { ...aScene, runId: input.runId });
  } });
  const readCurrent = f.overrides.readCurrentSession;
  f.overrides.readCurrentSession = async group => ({ ...await readCurrent(group), runId: f.scenes.get(group)?.runId });
  const first = f.add(), other = f.add(f.b);
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick();
  await until(() => { dispatcher.tick(); return launching && f.row(other.id).status === 'delivered'; }, 'B must deliver while A launch remains unresolved');
  assert.equal(f.row(first.id).status, 'running');
  assert.equal(f.calls.some(c => c[0] === 'paste' && c[1] === f.a), false);
  launchHold.resolve(); await dispatcher.idle();
  for (let i = 0; i < 3; i++) { dispatcher.tick(); await dispatcher.idle(); }
  assert.equal(f.row(first.id).status, 'delivered');
});

// READY deadline / Howard TG7342: omit configuration so the real factory
// selects the one product default for both runtimes; advance only fake time.
for (const runtime of ['claude', 'codex']) for (const outcome of ['timeout', 'boundary-ready', 'late-launch']) {
  test(`factory default READY deadline is 30000ms: ${runtime}/${outcome}`, async t => {
    const gate = deferred(); t.after(() => gate.resolve());
    const f = setup(t);
    t.after(() => f.db.getDb().prepare("UPDATE conversations SET status='failed' WHERE session_group IN (?,?) AND status IN ('pending','running')").run(f.a,f.b));
    let clock = Date.now(), started = false, stops = 0, delivered = 0, launchInput;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ runtime, session_mode: 'multi' }));
    delete f.options.readyTimeoutMs;
    f.overrides.now = () => clock;
    f.scenes.delete(f.a);
    f.overrides.getSessionAdapter = selected => ({
      launch: async input => {
        assert.equal(selected, runtime); launchInput = input; started = true;
        if (outcome === 'late-launch') await gate.promise;
        f.scenes.set(f.a, { present: true, ready: outcome === 'late-launch', runtime,
          runId: input.runId, sessionId: 'ready-business', tmuxName: tmuxNameForGroup(f.a), createdAt: Math.floor(clock/1000) });
      },
      stop: async input => { assert.equal(input.expectedRunId, launchInput.runId); stops++; f.scenes.delete(f.a); },
    });
    f.overrides.readCurrentSession = async group => {
      const scene = f.scenes.get(group);
      return scene?.ready ? { runId: scene.runId, sessionId: scene.sessionId, startupControlIds: [] } : null;
    };
    f.overrides.deliverConversation = async row => { delivered++; f.db.markDelivered(row.id, { sessionId: 'ready-business' }); };
    const row = f.add(), dispatcher = f.create();
    await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick();
    await until(() => { dispatcher.tick(); return started; }, () => `factory must launch absent group: ${JSON.stringify(f.calls)}`);
    if (outcome !== 'late-launch') await dispatcher.idle();
    clock += 29999;
    if (outcome === 'late-launch') { dispatcher.tick(); await flush(); }
    else await dispatcher.state.lanes.get(f.a).kick();
    assert.equal(stops, 0); assert.equal(delivered, 0); assert.equal(f.row(row.id).status, 'running');
    clock += 1;
    if (outcome === 'boundary-ready') f.scenes.get(f.a).ready = true;
    if (outcome === 'late-launch') {
      dispatcher.tick(); await flush();
      assert.equal(stops, 0); assert.equal(f.row(row.id).retry_count, 0);
      assert.ok(f.calls.some(c => c[0] === 'event' && c[1] === 'stop_unconfirmed' && c[2].reason === 'launch_pending'));
      gate.resolve(); await dispatcher.idle();
    }
    await dispatcher.state.lanes.get(f.a).kick();
    assert.equal(stops, outcome === 'timeout' ? 1 : 0);
    assert.equal(f.row(row.id).retry_count, outcome === 'timeout' ? 1 : 0);
    if (outcome === 'timeout') { assert.equal(delivered, 0); assert.equal(f.row(row.id).status, 'pending'); }
    else {
      await dispatcher.state.lanes.get(f.a).kick();
      assert.equal(delivered, 1); assert.equal(f.row(row.id).status, 'delivered');
    }
  });
}

// Run for receipt retry scheduling/diagnostic composition; skip unrelated UI.
// setup reads back isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and actual SQLite.
// Runtime and transport boundaries are injected; no tmux, account or network.
test('factory: permanent receipt failure backs off and terminates with structured diagnostics', async t => {
  const f = setup(t), row = f.add();
  f.db.claimConversation(row.id);
  f.db.failDelivery(row.id, { maxRetries: 1, reason: 'launch_failed' });
  let sends = 0;
  f.overrides.sendStatusNotice = async () => { sends++; return { outcome: 'uncertain' }; };
  const dispatcher = f.create();
  await dispatcher.initialize(); await dispatcher.idle();
  dispatcher.tick(); await dispatcher.idle();
  assert.equal(sends, 1);
  assert.equal(f.calls.filter(call => call[0] === 'event' && call[1] === 'failure_receipt_send_failed').length, 1);
  dispatcher.tick(); await dispatcher.idle();
  assert.equal(sends, 1, 'polling cannot bypass persisted backoff');
  f.db.getDb().prepare('UPDATE failure_receipts SET created_at=created_at-600 WHERE conversation_id=?').run(row.id);
  dispatcher.tick(); await dispatcher.idle();
  assert.equal(sends, 1);
  assert.equal(f.db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(row.id).state, 'failed');
  const terminal = f.calls.filter(call => call[0] === 'event' && call[1] === 'failure_receipt_exhausted');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0][2].conversation_id, row.id);
  dispatcher.tick(); await dispatcher.idle();
  assert.equal(sends, 1);
  assert.equal(f.calls.filter(call => call[0] === 'event' && call[1] === 'failure_receipt_exhausted').length, 1);
});
