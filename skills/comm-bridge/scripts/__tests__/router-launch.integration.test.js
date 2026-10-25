import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './c4-v2-test-helpers.js';
import { createRouter } from '../router/scheduler.js';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { getSessionAdapter } from '../../../../cli/lib/runtime/index.js';
import { createSessionReader } from '../../../../cli/lib/session-state-reader-async.js';
import { readReadyIdentity } from '../../../../cli/lib/runtime/session-target.js';
import { listGroupTmuxSessions } from '../../../../cli/lib/session-group-paths.js';

// IF10-7c: only the external runtime is replaced. Its READY file is a test
// producer, not evidence of the M3 hook or an authenticated runtime startup.
async function setup(t, { mode = 'multi', group = 'chat', runtime = 'claude' } = {}) {
  let router;
  let clock = Date.now();
  const tm = isolatedTmux(t, { prefix: 'router-launch-', beforeCleanup: () => router?.stop() });
  const previousRoot = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = tm.dir;
  t.after(() => { process.env.ZYLOS_DIR = previousRoot; });
  const configFile = path.join(tm.dir, 'config.json');
  const writeConfig = config => fs.writeFileSync(configFile, JSON.stringify(config));
  writeConfig({ runtime, session_mode: mode });
  let configReads = 0;
  const f = fixture(t, { readConfig: () => {
    configReads++;
    return { state: 'ok', config: JSON.parse(fs.readFileSync(configFile, 'utf8')) };
  } });
  const db = { ...f.store,
    getControlById: id => f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
    expireTimedOutControls: () => 0, cleanupControlQueue: () => 0,
  };
  const row = db.insertConversation('in', group === 'origin' ? 'system' : group ?? 'chat', 'endpoint', 'launch');
  if (mode === 'multi' && group !== 'origin') db.setDrainFence('origin', { reason: 'upgrade', runId: 'fixture-fence' });
  const executable = path.join(tm.dir, 'record-runtime');
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--help')) { console.log(' --model MODEL --effort EFFORT --no-daemon '); process.exit(0); }
const root=process.env.ZYLOS_DIR, group=process.env.ZYLOS_SESSION_GROUP;
const record={argv:process.argv.slice(2),runId:process.env.ZYLOS_RUN_ID,group:group??null,config:JSON.parse(process.env.ZYLOS_MODEL_CONFIG)};
fs.writeFileSync(path.join(root,'record.json'),JSON.stringify(record));
const dir=path.join(root,'activity-monitor/session-groups',group??'origin');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'current-session.json'),JSON.stringify({runId:record.runId,sessionId:'fixture-session',ts:Date.now(),startupControlIds:[]}));
setInterval(()=>{},1000);
`, { mode: 0o700 });
  const tmux = { binary: tm.binary, socketPath: tm.socketPath, configFile: '/dev/null' };
  const reader = createSessionReader({ connectionOptions: tmux });
  const events = [], launches = [], resolved = [];
  const resolve = db.resolveSessionLaunchConfig;
  db.resolveSessionLaunchConfig = input => {
    const value = resolve(input); resolved.push({ input, value }); return value;
  };
  let beforeLaunch = () => {};
  const deps = { db, now: () => clock,
    readSessionMode: () => ({ mode, keyPresent: true }),
    readLiveIdentity: reader.readLiveIdentity,
    readCurrentSession: readReadyIdentity,
    listGroupTmuxSessions: () => listGroupTmuxSessions(tmux),
    readRuntimeHealth: () => ({ health: 'ok', publicHealth: 'ok' }),
    getSessionAdapter: selected => {
      const adapter = getSessionAdapter(selected, { root: tm.dir, tmux,
        env: { PATH: process.env.PATH, HOME: tm.dir, ZYLOS_DIR: tm.dir },
        runtimeExecutable: () => executable });
      const launch = adapter.launch.bind(adapter);
      adapter.launch = async input => { launches.push(input); beforeLaunch(input); return launch(input); };
      return adapter;
    },
    submit: async () => assert.fail('healthy launch must not submit start_attempt'),
    deliverControl: async () => assert.fail('fixture has no controls'),
    deliverConversation: async (message, identity) => db.markDelivered(message.id, { sessionId: identity.sessionId }),
    handleExpired: async () => assert.fail('fresh fixture must not expire'),
    prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
    diagnostic: (event, fields) => events.push({ event, ...fields }),
  };
  router = createRouter(deps, { poolSize: 2, readyTimeoutMs: 10000 });
  async function run() {
    await router.initialize(); await router.idle();
    // Advance the resident's five-second absence gate without pretending this
    // is real startup timing; then hold the clock while real processes settle.
    for (let n = 0; n < 30; n++) {
      if (n < 7) clock += 1000;
      router.tick(); await router.idle(); await router.idle();
      if (f.db.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status === 'delivered') break;
      if (events.some(event => event.event === 'activate_failed' && event.reason === 'CONFIG_UNREADABLE')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const recordFile = path.join(tm.dir, 'record.json');
    t.diagnostic(JSON.stringify({
      record: fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : null,
      live: await reader.readLiveIdentity(group),
      ledger: f.db.prepare('SELECT id,status,session_id,retry_count FROM conversations WHERE id=?').get(row.id),
      events: events.map(({ event }) => event),
    }));
  }
  return { ...f, db, tm, router, row, group, events, launches, resolved, run, writeConfig,
    get configReads() { return configReads; }, set beforeLaunch(fn) { beforeLaunch = fn; },
    record: () => { assert.ok(fs.existsSync(path.join(tm.dir, 'record.json')), JSON.stringify({ events, activations: [...router.state.activations.values()].map(a => ({ ...a, launchError: a.launchError?.stack })) })); return JSON.parse(fs.readFileSync(path.join(tm.dir, 'record.json'), 'utf8')); },
    live: () => reader.readLiveIdentity(group),
  };
}

function assertLaunch(record, live, expected, group) {
  assert.deepEqual(record.config, expected);
  assert.deepEqual(live.launchConfig, expected);
  assert.equal(record.runId, live.runId);
  assert.match(record.runId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.equal(record.group, group);
  assert.equal(live.ready, true);
  assert.equal(live.sessionId, 'fixture-session');
  assert.equal(record.argv.some(value => /^(?:--resume|resume|--continue)$/.test(value)), false);
  if (expected.mode === 'default') {
    assert.equal(record.argv.includes('--model'), false);
    assert.equal(record.argv.includes('--effort'), false);
    assert.equal(record.argv.some(value => value.startsWith('model_reasoning_effort=')), false);
  } else {
    assert.equal(record.argv[record.argv.indexOf('--model') + 1], expected.model);
    if (expected.runtime === 'claude') assert.equal(record.argv[record.argv.indexOf('--effort') + 1], expected.effort);
    else assert.ok(record.argv.includes(`model_reasoning_effort=${JSON.stringify(expected.effort)}`));
  }
}

for (const runtime of ['claude', 'codex']) for (const override of [false, true]) {
  test(`IF10-7c real P01/P02 ${runtime} ${override ? 'override' : 'default'} matches argv/F2`, async t => {
    const f = await setup(t, { runtime });
    const expected = override ? { runtime, mode: 'override', model: 'model name', effort: 'high' } : { runtime, mode: 'default' };
    if (override) f.db.setSessionModelConfig({ sessionGroup: f.group, ...expected });
    await f.run();
    assertLaunch(f.record(), await f.live(), expected, f.group);
    assert.equal(f.configReads, 1); assert.equal(f.launches.length, 1);
    assert.equal(f.db.getNextPending({ sessionGroups: [f.group] }), null);
  });
}

test('IF10-7c single ignores origin overrides and omits group from runtime environment', async t => {
  const f = await setup(t, { mode: 'single', group: null });
  f.db.setSessionRuntimeConfig({ sessionGroup: 'origin', runtime: 'codex' });
  f.db.setSessionModelConfig({ sessionGroup: 'origin', runtime: 'codex', model: 'ignored', effort: 'high' });
  await f.run();
  assertLaunch(f.record(), await f.live(), { runtime: 'claude', mode: 'default' }, null);
  assert.equal(f.configReads, 1); assert.equal(f.launches.length, 1);
});

test('IF10-7c multi origin consumes its runtime and model override', async t => {
  const f = await setup(t, { group: 'origin' });
  const expected = { runtime: 'codex', mode: 'override', model: 'origin-model', effort: 'xhigh' };
  f.db.setSessionRuntimeConfig({ sessionGroup: 'origin', runtime: 'codex' });
  f.db.setSessionModelConfig({ sessionGroup: 'origin', ...expected });
  await f.run();
  assertLaunch(f.record(), await f.live(), expected, 'origin');
  assert.equal(f.configReads, 1); assert.equal(f.launches.length, 1);
});

test('IF10-7c one resolved config survives F1/D10/D11 changes before adapter launch', async t => {
  const f = await setup(t);
  const expected = { runtime: 'claude', mode: 'override', model: 'original', effort: 'high' };
  f.db.setSessionModelConfig({ sessionGroup: f.group, ...expected });
  f.beforeLaunch = () => {
    f.writeConfig({ runtime: 'codex', session_mode: 'multi' });
    f.db.setSessionRuntimeConfig({ sessionGroup: f.group, runtime: 'codex' });
    f.db.setSessionModelConfig({ sessionGroup: f.group, runtime: 'codex', model: 'changed', effort: 'low' });
  };
  await f.run();
  assertLaunch(f.record(), await f.live(), expected, f.group);
  assert.equal(f.configReads, 1); assert.equal(f.launches.length, 1);
});

test('IF10-7c unreadable F1 leaves fresh conversation pending without adapter launch', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.tm.dir, 'config.json'), '{');
  await f.run();
  assert.equal(f.launches.length, 0);
  assert.equal(f.db.getNextPending({ sessionGroups: [f.group] }).id, f.row.id);
  assert.ok(f.events.some(event => event.event === 'activate_failed' && event.reason === 'CONFIG_UNREADABLE'));
  assert.equal(fs.existsSync(path.join(f.tm.dir, 'record.json')), false);
});

test('IF10-7c same argv/F2 oracle rejects re-resolving configuration at adapter boundary', async t => {
  const f = await setup(t);
  const expected = { runtime: 'claude', mode: 'override', model: 'original', effort: 'high' };
  f.db.setSessionModelConfig({ sessionGroup: f.group, ...expected });
  f.beforeLaunch = input => {
    f.db.setSessionModelConfig({ sessionGroup: f.group, runtime: 'claude', model: 'changed', effort: 'low' });
    // Deliberate bad adapter caller: production source remains untouched.
    input.launchConfig = f.db.resolveSessionLaunchConfig({ sessionGroup: f.group, sessionMode: 'multi' });
  };
  await f.run();
  const record = f.record(), live = await f.live();
  assert.equal(record.config.model, 'changed');
  assert.equal(f.configReads, 2);
  assert.throws(() => assertLaunch(record, live, expected, f.group), { code: 'ERR_ASSERTION' });
});
