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
const { messageForStatus } = await import('../status-notice-templates.js');
const { CONFIG_FILE, SKILLS_DIR } = await import('../../../../cli/lib/config.js');
const { tmuxNameForGroup } = await import('../../../../cli/lib/session-group-paths.js');
after(() => { database.close(); environment.cleanup(); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message) { for (let i = 0; i < 2000; i++) { if (predicate()) return; await flush(); } assert.fail(typeof message === 'function' ? message() : message); }
let sequence = 0;
function configuration(mode = 'multi') {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ runtime: 'codex', session_mode: mode }));
}
function setup(t, { mode = 'multi', phase } = {}) {
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
  const db = { ...database };
  const overrides = {
    db, diagnostics: { diagnostic: (...args) => calls.push(['event', ...args]), maintain() {}, flush() {} }, log: message => calls.push(['log', message]),
    listGroupTmuxSessions: async () => keys.map(sessionGroup => ({ sessionGroup, ...scenes.get(sessionGroup) })),
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
  const options = { readyTimeoutMs: 1000, poolSize: 2,
    delivery: { periodicEnabled: false, verifyWaitMs: 1, idleHoldMs: 31, idleWaitMs: 100, idlePollMs: 1, retryBaseMs: 37 } };
  let dispatcher;
  t.after(async () => { held.resolve(); await dispatcher?.stop(); });
  return { a,b,db,calls,overrides,options,held,scenes,holding: () => holding,
    create(create = createDispatcher) { return dispatcher = create(overrides, options); },
    add(channel = a, content = 'hello', options = {}) { return db.insertConversation('in', channel, `endpoint-${channel}`, content, options); },
    row(id) { return db.getDb().prepare('SELECT * FROM conversations WHERE id=?').get(id); },
  };
}

for (const phase of ['paste','enter','idle','backoff']) test(`IF12 factory: ${phase} wait holds only its lane; real claims/settlement preserve same-group order`, async t => {
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

test('IF70 factory: real expiry + shared D4 sender happen post-commit, then next fresh row delivers', async t => {
  const f = setup(t), old = f.add(), fresh = f.add(f.a, 'fresh after expiry');
  f.db.getDb().prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(Math.floor(Date.now()/1000)-1801, old.id);
  const attempts = [], config = { language: 'en', brand: 'Factory' };
  f.overrides.sendStatusNotice = createStatusNoticeSender({ db: f.db,
    render: route => { assert.equal(f.row(old.id).delivery_action, 'pending_expired'); return messageForStatus(route, config); },
    diagnostic() {}, spawn: (_command, args) => {
      const child = new EventEmitter(); child.pid = 12; child.stdin = new EventEmitter();
      child.stdin.end = body => { attempts.push({ args, body }); queueMicrotask(() => child.emit('close', 0, null)); };
      child.kill = () => {}; return child;
    } });
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  assert.equal(f.row(old.id).status, 'failed'); assert.equal(f.row(old.id).delivery_action, 'pending_expired');
  assert.equal(f.row(fresh.id).status, 'delivered'); assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].args.slice(1), [f.a, `endpoint-${f.a}`]);
  assert.equal(attempts[0].body, messageForStatus({ runtime: 'codex', health: 'ok', reason: 'pending_expired', noticeKind: 'pending_expired' }, config));
  assert.equal(f.calls.filter(c => c[0] === 'paste').length, 1);
  assert.ok(f.db.getStatusNoticeCooldowns().some(c => c.cooldown_key.includes('pending_expired')));
});

test('T01 factory: actual unreadable F1 remains inert once, even if config repaired', async t => {
  const f = setup(t); fs.writeFileSync(CONFIG_FILE, '{broken');
  const alerts = []; f.overrides.alert = (...args) => alerts.push(args);
  f.overrides.listGroupTmuxSessions = async () => assert.fail('inert factory must not observe terminals');
  f.overrides.db = { ...f.db, recoverOrphanRunning: () => assert.fail('inert factory must not recover DB') };
  const dispatcher = f.create(); await dispatcher.initialize(); configuration('multi');
  await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  assert.equal(dispatcher.state.inert, true); assert.equal(alerts.length, 1);
});

test('T01/T04 factory: actual single F1 directs a non-null D1 group through null origin target', async t => {
  const f = setup(t, { mode: 'single' }), row = f.add();
  assert.equal(f.row(row.id).session_group, f.a);
  const dispatcher = f.create(); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick(); await dispatcher.idle();
  assert.equal(f.row(row.id).status, 'delivered'); assert.equal(f.row(row.id).session_id, 'business-null');
  assert.deepEqual(f.calls.filter(c => c[0] === 'resolve'), [['resolve', null]]);
  assert.equal(f.calls.find(c => c[0] === 'notify')[1].sessionGroup, null);
});

test('IF12 factory oracle rejects a known-bad scheduler that waits for previous lanes', async t => {
  const schedulerURL = new URL('../router/scheduler.js', import.meta.url), factoryURL = new URL('../router/factory.js', import.meta.url);
  const original = fs.readFileSync(schedulerURL, 'utf8');
  const before = 'const work = lane(group).kick();';
  assert.ok(original.includes(before));
  const absolute = (source, url) => source.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => `from '${new URL(relative, url).href}'`);
  const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const altered = absolute(original.replace(before,
    'const work = tasks.size ? Promise.allSettled([...tasks]).then(() => lane(group).kick()) : lane(group).kick();'), schedulerURL);
  const factorySource = absolute(fs.readFileSync(factoryURL, 'utf8'), factoryURL).replace(schedulerURL.href, uri(altered));
  const bad = (await import(uri(factorySource))).createDispatcher;
  const f = setup(t, { phase: 'paste' }), first = f.add(), second = f.add(f.b);
  const dispatcher = f.create(bad); await dispatcher.initialize(); await dispatcher.idle(); dispatcher.tick();
  await until(f.holding, 'mutant must reach the held paste');
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(f.row(first.id).status, 'running');
  assert.throws(() => assert.equal(f.row(second.id).status, 'delivered'), { code: 'ERR_ASSERTION' });
  assert.equal(f.row(second.id).status, 'pending');
  f.held.resolve(); await dispatcher.idle();
  assert.equal(f.row(second.id).status, 'delivered');
});

test('IF12 factory: blocked paste in live A does not prevent absent B from launching and delivering', async t => {
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

test('IF12 factory: held launch in absent A does not block existing READY B delivery', async t => {
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
