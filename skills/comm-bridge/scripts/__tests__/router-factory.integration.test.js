import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const database = await import('../c4-db.js');
const { createDispatcher } = await import('../router/factory.js');
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
    session: {
      sendText: async input => { calls.push(['paste', input.target.sessionGroup, input.text]);
        if (input.target.sessionGroup === a && !blockedOnce && ['paste','backoff'].includes(phase)) {
          blockedOnce = true;
          if (phase === 'paste') await wait(); else throw Error('paste failure');
        } },
      sendKeys: async input => { calls.push(['keys', input.target.sessionGroup, input.keys]);
        if (input.target.sessionGroup === a && !blockedOnce && phase === 'enter') { blockedOnce = true; await wait(); } },
      captureScreen: async () => '❯ ',
      launch: async () => assert.fail('fixture has READY scene'), stop: async () => assert.fail('fixture has READY scene'),
    },
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
