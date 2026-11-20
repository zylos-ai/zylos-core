import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const database = await import('../c4-db.js');
const { createDispatcher } = await import('../router/factory.js');
const { messageForFailureAlert } = await import('../failure-receipt-template.js');
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
  const keys = mode === 'single' ? ['origin'] : ['origin', a, b];
  const scenes = new Map(keys.map(group => [group, { present: true, ready: true, runtime: 'codex',
    runId: `r-${group}`, sessionId: `business-${group}`, runtimeSessionId: `business-${group}`,
    tmuxName: tmuxNameForGroup(group ?? 'origin'), serverGeneration: 'test-generation', paneId: `%${group}`, createdAt: Math.floor(Date.now()/1000) }]));
  const target = group => ({ ...scenes.get(group), sessionGroup: group, sessionId: `$${group}` });
  const wait = async () => { holding = true; await held.promise; };
  database.getDb().exec('DELETE FROM slot_occupancy'); // Each fixture owns its occupancy; this file shares one database.
  const db = { ...database };
  const overrides = {
    env: { ...process.env, ZYLOS_SESSION_POOL_SIZE: '2' },
    sendAlert: async (target, message) => { calls.push(['owner_alert', target, message]); return true; },
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
    findLegacySessions: async () => [], advanceLegacy: async () => {},
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

test('factory: real expiry sends only an owner alert after commit, then fresh work delivers', async t => {
  const f = setup(t), old = f.add(), fresh = f.add(f.a, 'fresh after expiry');
  f.db.getDb().prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(Math.floor(Date.now()/1000)-1801, old.id);
  const attempts = [];
  f.overrides.readZylosConfigStrict = () => ({ state: 'ok', config: { alert_target: 'owner-test:owner-private' } });
  f.overrides.sendStatusNotice = async () => assert.fail('terminal expiry must not reply to the external chat');
  f.overrides.sendAlert = async (target, body) => {
    assert.equal(f.row(old.id).delivery_action, 'pending_expired');
    attempts.push({ target, body }); return true;
  };
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  await until(() => attempts.length === 1, 'expiry owner alert did not send');
  assert.equal(f.row(old.id).status, 'failed'); assert.equal(f.row(old.id).delivery_action, 'pending_expired');
  assert.equal(f.row(fresh.id).status, 'delivered'); assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].target, { channel: 'owner-test', endpoint: 'owner-private' });
  assert.equal(attempts[0].body, messageForFailureAlert({ ...old, reason: 'pending_expired' }));
  for (let i = 0; i < 3; i++) { dispatcher.tick(); await dispatcher.idle(); }
  assert.equal(attempts.length, 1, 'settled owner alert must not be sent again');
  assert.equal(f.calls.filter(c => c[0] === 'paste').length, 1);
  assert.ok(f.db.getStatusNoticeCooldowns().some(c => c.cooldown_key.includes('pending_expired')));
});

// Recovery boundary: run for orphan settlement/owner alerts; skip unrelated UI.
// setup proves private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and SQLite; terminal and
// channel edges are injected. No tmux/socket/account is contacted.
test('factory: startup orphan failure alerts once and never redelivers the original', async t => {
  const f = setup(t), original = f.add(f.a, 'private original input');
  f.db.claimConversation(original.id);
  f.db.getDb().prepare('UPDATE conversations SET retry_count=1 WHERE id=?').run(original.id);
  const attempts = [];
  f.overrides.readZylosConfigStrict = () => ({ state: 'ok', config: { alert_target: 'owner-test:owner-private' } });
  f.overrides.sendStatusNotice = async () => assert.fail('terminal failure must not reply to original chat');
  f.overrides.sendAlert = async (target, body) => { attempts.push({ target, body }); };
  const fresh = f.add(f.a, 'fresh after startup failure');
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); await flush();
  for (let i = 0; i < 3; i++) { dispatcher.tick(); await dispatcher.idle(); }
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].target, { channel: 'owner-test', endpoint: 'owner-private' });
  assert.equal(attempts[0].body, messageForFailureAlert({ ...original, reason: 'orphan_retry_exhausted' }));
  assert.equal(attempts[0].body.includes('private original input'), false);
  assert.equal(f.row(original.id).status, 'failed');
  assert.equal(f.row(fresh.id).status, 'delivered');
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

test('factory: native single directs a non-null group through Origin and changes attribution', async t => {
  const f = setup(t, { mode: 'single' }), row = f.add();
  assert.equal(f.row(row.id).session_group, f.a);
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  assert.equal(f.row(row.id).status, 'delivered'); assert.equal(f.row(row.id).session_id, 'business-origin');
  assert.equal(f.row(row.id).session_group, 'origin');
  assert.deepEqual(f.calls.filter(c => c[0] === 'resolve'), [['resolve', 'origin']]);
  assert.equal(f.calls.find(c => c[0] === 'notify')[1].sessionGroup, 'origin');
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
