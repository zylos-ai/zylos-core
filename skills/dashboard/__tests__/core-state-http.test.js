import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { createGroupSnapshot, systemSample } from '../src/lib/workbench/group-snapshot.js';
import { scheduleEnv } from './fixtures/schedule-env.js';

// HTTP/SQLite integration for CoreState API wiring: run for state refresh, fleet,
// stream admission, session metrics or action metadata changes; skip UI-only work.
// Real routes, CoreState and Store; mock only Core observation at the module seam.
// All host paths, databases and tmux directory are private; no service or tmux
// command starts. Only a loopback HTTP listener runs, closed with all handles below.
test('state APIs await a fresh observation before answering idle requests', { timeout: 20000 }, async t => {
  const install = scheduleEnv(t, { link: false });
  const previous = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX', 'DASHBOARD_PORT'].map(key => [key, process.env[key]]));
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) process.env[key] = install.env[key];
  delete process.env.TMUX;
  process.env.DASHBOARD_PORT = '0';
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(process.env[key].startsWith(install.root + path.sep));
  assert.notEqual(fs.realpathSync(process.env.HOME), fs.realpathSync(os.userInfo().homedir));
  assert.ok(Buffer.byteLength(path.join(process.env.TMUX_TMPDIR, 'test.sock')) < 104);
  console.log('Core API HTTP isolation:', JSON.stringify({ ...Object.fromEntries(Object.keys(previous).map(key => [key, process.env[key] ?? null])),
    database: path.join(install.zylosDir, 'components/dashboard/dashboard.db'), tmux: 'mock Core observation; no commands', network: 'loopback only' }));
  fs.mkdirSync(path.join(install.zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(install.zylosDir, '.zylos/config.json'), JSON.stringify({ session_mode: 'single', runtime: 'codex' }));
  const dashboardDir = path.join(install.zylosDir, 'components/dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'secret' } }));
  let sample = 0, nextRead, releaseRead, releaseActive, snapshotClock = Date.now();
  const observation = value => ({ identity: { present: true, ready: true, runtime: 'codex', runId: `run-${value}`, sessionId: `session-${value}` },
    status: { valid: true, reason: null, value: { state: 'idle' } },
    usage: { valid: true, value: { model: `model-${value}`, contextUsage: { used: value, ceiling: 100 } } } });
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode: 'single' }) };
    if (name === 'session-state-reader.js') return {
      readSessionStates: async () => {
        const value = ++sample;
        nextRead?.();
        if (releaseRead) await releaseRead;
        return new Map([[null, observation(value)]]);
      },
      readAccountUsageSnapshot: async () => ({ live: null, recorded: null }),
    };
    return import(new URL(`../../../cli/lib/${name}`, import.meta.url));
  } } });
  t.mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: {
    systemSample,
    createGroupSnapshot: options => createGroupSnapshot({ ...options, now: () => snapshotClock,
      cli: { runC4Db: async () => ({ ok: true, data: { groups: [], hasOlder: false } }),
        readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'codex' }, runtime: [], model: [] } }) },
      loadCoreModule: async name => {
        if (name === 'config.js') return { readSessionMode: () => ({ mode: 'single' }) };
        if (name === 'session-state-reader.js') return { readSessionState: async () => observation(sample), readAccountUsageSnapshot: async () => ({ live: null, recorded: null }) };
        if (name === 'status-view.js') return { collectStatus: async ({ session }) => {
          await session(null, {});
          return { view: 'single', origin: { presence: 'running', runtime: 'codex', runId: `run-${sample}`, sessionId: `session-${sample}`, status: { valid: true, state: 'idle' } }, groupListError: null, runtimeHealth: {} };
        } };
        return import(new URL(`../../../cli/lib/${name}`, import.meta.url));
      } }),
  } });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  const stores = new Set(), timers = new Set();
  const checkSchema = Store.prototype.checkSchema, interval = globalThis.setInterval;
  t.mock.method(Store.prototype, 'checkSchema', function (...args) { stores.add(this); return checkSchema.apply(this, args); });
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = interval(...args); timers.add(timer); return timer; });
  let server;
  const streams = new Set();
  t.after(async () => {
    releaseActive?.();
    releaseRead = null;
    for (const controller of streams) controller.abort();
    for (const timer of timers) clearInterval(timer);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeAttachments?.(); }
    for (const store of stores) if (store.db.open) store.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const { createServer } = await import(`../src/index.js?fresh-state=${Date.now()}`);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=secret' });
  await login.text();
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session=')).split(';')[0];
  const beforeOptions = sample;
  const runtimeOptions = await fetch(origin + '/api/instance/runtime-options', { headers: { cookie }, signal: t.signal });
  assert.equal(runtimeOptions.status, 200);
  const options = await runtimeOptions.json();
  for (const key of ['running_model', 'running_effort']) assert.equal(Object.hasOwn(options, key), false);
  assert.equal(sample, beforeOptions, 'runtime options do not collect Origin observations');
  for (const route of ['/api/fleet', '/api/instance', '/api/stream']) {
    const before = sample; snapshotClock += 2100;
    let entered, release;
    const began = new Promise(resolve => { entered = resolve; });
    nextRead = entered;
    releaseRead = new Promise(resolve => { release = resolve; });
    releaseActive = release;
    const controller = new AbortController(); streams.add(controller);
    let answered = false;
    const pending = fetch(origin + route, { headers: { cookie }, signal: AbortSignal.any([controller.signal, t.signal]) }).then(response => { answered = true; return response; });
    try {
      await Promise.race([began, pending.then(() => { if (sample === before) assert.fail(`${route} answered without refreshing`); })]);
      assert.equal(answered, false, `${route} waits for the fresh observation`);
      release();
      const response = await pending;
      assert.equal(response.status, 200);
      const expected = before + 1;
      assert.equal(sample, expected, 'one shared refresh per request');
      if (route === '/api/stream') {
        const reader = response.body.getReader();
        let frames = '';
        for (let i = 0; i < 8 && !frames.includes('event: instance'); i++) {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          frames += new TextDecoder().decode(value);
          assert.ok(frames.length < 65536);
        }
        assert.match(frames, /event: instance/);
        const instanceFrame = frames.split('event: instance\ndata: ')[1]?.split('\n\n')[0];
        const instance = JSON.parse(instanceFrame);
        assert.equal(instance.session_mode.sessionMode, 'single');
        assert.equal(Object.hasOwn(instance, 'runtime_info'), false, 'observed model belongs to group detail');
        assert.equal(Object.hasOwn(instance, 'poolCapacityRecord'), false);
        assert.deepEqual(Object.keys(instance.versions).sort(), ['claude', 'codex', 'zylos']);
        await reader.cancel();
      } else {
        const body = await response.json();
        if (route === '/api/fleet') for (const field of ['model', 'effort', 'context_pct', 'new_session_threshold']) assert.equal(Object.hasOwn(body.agents[0], field), false, 'Fleet omits Origin session metadata');
        else {
          assert.equal(body.session_mode.sessionMode, 'single');
          assert.equal(Object.hasOwn(body, 'runtime_info'), false);
          assert.equal(Object.hasOwn(body, 'poolCapacityRecord'), false);
          assert.deepEqual(Object.keys(body.versions).sort(), ['claude', 'codex', 'zylos']);
        }
      }
      const detailResponse = await fetch(origin + '/api/groups/origin?include=', { headers: { cookie }, signal: t.signal });
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json();
      assert.equal(detail.runtimeInfo.model, `model-${expected}`, 'the fresh observed model remains available on its group');
      assert.equal(detail.run.runId, `run-${expected}`);
      assert.equal(sample, expected, 'the detail read shares the captured observation without another Core refresh');
    } finally { release(); controller.abort(); streams.delete(controller); nextRead = null; releaseRead = null; releaseActive = null; }
  }
});
