import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as database from '../c4-db.js';
import { createDispatcher } from '../router/factory.js';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';

// Run only with isolated HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, private tmux
// socket paths and test databases; never use live resources. All external I/O
// in this file is injected; setup reads back and asserts the isolation paths.

after(() => database.close());

const consoleTarget = { channel: 'web-console', endpoint: 'console' };
const defaultMessage = count => `[Zylos] 对话「a」连续 ${count} 次没能重启。最后一次的原因：启动报错（START_FAILED）。系统会继续重试；已在排队的消息可能在恢复前失败。\n[Zylos] Conversation "a" could not restart: ${count} attempts failed in a row. Last failure: launch error (START_FAILED). It keeps retrying. Messages already queued for this conversation can fail before it recovers.`;

async function setup(t, { readConfig = () => ({ state: 'ok', config: {} }), send = async () => true } = {}) {
  const f = routerFixture(t);
  const paths = Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR'].map(key => [key, process.env[key]]));
  const realHome = os.userInfo().homedir;
  for (const value of Object.values(paths)) assert.ok(value && value !== realHome && !value.startsWith(realHome + '/'));
  assert.ok(paths.ZYLOS_DIR.startsWith(paths.HOME + '/'));
  assert.ok(paths.PM2_HOME.startsWith(paths.HOME + '/'));
  assert.equal(f.filename, ':memory:');
  t.diagnostic(JSON.stringify({ paths, database: f.filename, externalIO: 'injected' }));
  f.put('origin');
  const row = f.add('a');
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
  f.db.recordRunEnd('a', { runId: 'previous', reason: 'unexpected' });
  const sends = [], logs = [];
  const adapter = f.deps.getSessionAdapter;
  const dependencies = { ...f.deps,
    readZylosConfigStrict: (() => { let initial = true; return () => {
      if (initial) { initial = false; return { state: 'ok', config: {} }; }
      return readConfig();
    }; })(),
    diagnostics: { diagnostic: f.deps.diagnostic, maintain() {} },
    log: message => logs.push(message),
    sendAlert: async (target, message) => { sends.push({ target, message }); return send(target, message, sends.length); },
    getSessionAdapter: runtime => ({ ...adapter(runtime), launch: async input => {
      f.calls.push(['launch', input]);
      throw Object.assign(Error('private launch diagnostic must not appear in a notice'), { code: 'START_FAILED' });
    } }),
  };
  delete dependencies.alert;
  const dispatcher = createDispatcher(dependencies, { ...f.options, delivery: { periodicEnabled: false } });
  t.after(async () => { await dispatcher.stop(); });
  async function rounds(n = 3) {
    for (let i = 0; i < n; i++) { dispatcher.tick(); await dispatcher.idle(); await flush(); }
  }
  await dispatcher.initialize();
  await rounds(2);
  async function failAfter(ms) { f.advance(ms); await rounds(); }
  async function fiveFailures() {
    for (const delay of [5000, 10000, 20000, 40000, 60000]) await failAfter(delay);
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, 5);
    assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 1);
    assert.equal(f.db.listPendingContinuations().some(row => row.sessionGroup === 'a'), true);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM control_queue').get().n, 0);
    for (let i = 0; i < 100 && sends.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(sends.length > 0, 'lazy notification path starts');
    await flush();
  }
  return { ...f, dispatcher, sends, logs, rounds, failAfter, fiveFailures };
}

test('dispatcher preserves startup configuration read errors', () => {
  assert.throws(() => createDispatcher({ readZylosConfigStrict: () => { throw Error('startup configuration unavailable'); } }),
    /startup configuration unavailable/);
});

// Other-event boundary: run for factory alert routing changes; skip unrelated copy.
// The real startup path uses isolated HOME/ZYLOS_DIR/PM2_HOME and an in-memory DB;
// mode/config and send I/O are injected, with no live runtime or communication.
test('dispatcher logs unreadable session configuration without notifying the owner', async t => {
  const f = routerFixture(t);
  const sends = [], logs = [];
  const dependencies = { ...f.deps,
    readZylosConfigStrict: () => ({ state: 'ok', config: {} }),
    readSessionMode: () => { throw Object.assign(Error('unreadable configuration'), { code: 'CONFIG_UNREADABLE' }); },
    diagnostics: { diagnostic: f.deps.diagnostic, maintain() {} },
    log: message => logs.push(message),
    sendAlert: async (target, message) => { sends.push({ target, message }); return true; },
  };
  delete dependencies.alert;
  const dispatcher = createDispatcher(dependencies, { ...f.options, delivery: { periodicEnabled: false } });
  t.after(() => dispatcher.stop());
  await dispatcher.initialize();
  assert.equal(dispatcher.state.inert, true);
  assert.ok(f.events.some(event => event.event === 'config_unreadable'));
  assert.ok(logs.includes('Router alert: config_unreadable {}'));
  // Drain the same lazy imports used by notifications before asserting no send.
  await Promise.all([
    import('../../../activity-monitor/scripts/supervisor-server-health.js'),
    import('../../../activity-monitor/scripts/supervisor-server-observation.js'),
  ]);
  await flush();
  assert.equal(sends.length, 0);
});

// Factory alert composition boundary: run for routing/template changes; skip unrelated UI.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME; SQLite is in-memory and runtime/send I/O is injected.
test('dispatcher sends current defaults to the configured destination and reloads destination and templates', async t => {
  let config = { alert_target: 'telegram:owner-one' };
  const f = await setup(t, { readConfig: () => ({ state: 'ok', config }) });
  await f.fiveFailures();
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].target, { channel: 'telegram', endpoint: 'owner-one' });
  assert.equal(f.sends[0].message, defaultMessage(5));
  config = { alert_target: 'lark:owner-two', statusNotices: { brand: 'Partner', templates: { repeated_failure: {
    could_not_restart: { zh: '{group}/{count}/{reason}', en: '{group}:{count}:{reason}' },
    could_not_restart_launch_error: { zh: '错误 {code}', en: 'failure {code}' },
  } } } };
  await f.failAfter(1800000);
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends[1].target, { channel: 'lark', endpoint: 'owner-two' });
  assert.equal(f.sends[1].message, '[Partner] a/6/错误 START_FAILED\n[Partner] a:6:failure START_FAILED');
});

for (const configuration of ['missing', 'invalid', 'unreadable', 'throws']) {
  // Config failure boundary: run for config-reader or alert-target changes; skip unrelated delivery formatting.
  // Only this test's config reader fails; real scheduler/store and production fallback remain active.
  test(`dispatcher uses default copy and Web Console when alert configuration is ${configuration}`, async t => {
    const readConfig = () => {
      if (configuration === 'throws') throw Error('configuration unavailable');
      if (configuration === 'unreadable') return { state: 'error', error: 'unavailable' };
      return { state: 'ok', config: configuration === 'invalid' ? { alert_target: 'invalid' } : {} };
    };
    const f = await setup(t, { readConfig });
    await f.fiveFailures();
    assert.equal(f.sends.length, 1);
    assert.deepEqual(f.sends[0].target, consoleTarget);
    assert.equal(f.sends[0].message, defaultMessage(5));
  });
}

for (const failure of ['false', 'reject']) {
  // Transport fallback boundary: run for factory/shared notifier changes; skip unrelated scheduler changes.
  // The send substitute records calls only and never reaches a real communication channel.
  test(`dispatcher falls back to Web Console when configured delivery returns ${failure}`, async t => {
    const f = await setup(t, { readConfig: () => ({ state: 'ok', config: { alert_target: 'telegram:owner' } }),
      send: async (_target, _message, attempt) => {
        if (attempt === 1) { if (failure === 'reject') throw Error('transport unavailable'); return false; }
        return true;
      } });
    await f.fiveFailures();
    assert.equal(f.sends.length, 2);
    assert.deepEqual(f.sends[0].target, { channel: 'telegram', endpoint: 'owner' });
    assert.deepEqual(f.sends[1].target, consoleTarget);
    assert.equal(f.sends[0].message, defaultMessage(5));
    assert.equal(f.sends[1].message, defaultMessage(5));
  });
}

// Failed-send cooldown boundary: run for notifier or continuation window changes; skip unrelated UI.
// Both destinations are injected failures; injected clock proves next-round progress and exact cooldown.
test('dispatcher logs both rejected deliveries without reopening the machine window', async t => {
    const f = await setup(t, { readConfig: () => ({ state: 'ok', config: { alert_target: 'telegram:owner' } }),
      send: async () => { throw Error('transport unavailable'); } });
    await f.fiveFailures();
    assert.equal(f.sends.length, 2);
    assert.equal(f.logs.filter(value => value?.message === 'transport unavailable').length, 2, 'both transport rejections are logged');
    await f.failAfter(60000);
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, 6);
    assert.equal(f.sends.length, 2);
    await f.failAfter(1739000);
    assert.equal(f.sends.length, 2, '29:59 still uses the existing window');
    await f.failAfter(1000);
    // Backoff is independent of the alert window; the next eligible failed start emits the alert.
    await f.failAfter(60000);
    assert.equal(f.sends.length, 4);
});

// Pending-send lifecycle boundary: run for alert awaiting or Router stop changes; skip unrelated templates.
// The unresolved promise has no worker/process; cleanup always releases it before test teardown.
test('dispatcher scheduling and shutdown finish while notification delivery is pending', { timeout: 5000 }, async t => {
  const hold = deferred();
  t.after(() => hold.resolve(true));
  const f = await setup(t, { send: () => hold.promise });
  try {
    await f.fiveFailures();
    assert.equal(f.sends.length, 1);
    await f.failAfter(60000);
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, 6);
    const message = f.add('system');
    assert.equal(message.session_group, 'origin');
    await f.rounds(3);
    assert.equal(f.row(message.id).status, 'delivered');
    await f.dispatcher.stop();
    assert.equal(f.sends.length, 1);
  } finally { hold.resolve(true); await flush(); }
});
