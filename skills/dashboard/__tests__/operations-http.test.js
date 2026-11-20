import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { CoreState } from '../src/lib/core-state.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { AuthGate, generateApiKey, hashApiKey } from '../src/lib/auth.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { nudgeSession } from '../../../cli/lib/session-nudge.js';
import { collectStatus } from '../../../cli/lib/status-view.js';

const states = ['working', 'idle', 'starting', 'stopping', 'unknown'];
const flags = ['queued', 'blocked', 'waitingSlot', 'startFailed', 'unreadable', 'noResponse'];
const healthStates = ['ok', 'auth_failed', 'rate_limited', 'unavailable', 'down', 'recovering'];
const iso = value => {
  assert.equal(typeof value, 'string');
  assert.equal(new Date(value).toISOString(), value);
};
const nullableString = value => assert.ok(value === null || typeof value === 'string');

// Integration boundary: real createServer, key exchange/AuthGate, API dispatch,
// readiness projection, group projection, action adapters, usage SQL and wire
// serialization. Run for operations contract changes; UI-only changes may skip.
// Core observations/IPC and command results are injected before server import;
// no supervisor, tmux, PM2 or external network is contacted. The official runner
// must isolate HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR. All requests are bounded;
// teardown closes owned listeners, timers, readers and private SQLite stores.
test('operations HTTP contracts retain observations and scoped Origin actions in both modes', { timeout: 30_000 }, async t => {
  assert.notEqual(fs.realpathSync(process.env.HOME), fs.realpathSync(os.userInfo().homedir));
  const runnerRoot = path.dirname(process.env.HOME);
  for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key].startsWith(runnerRoot + path.sep), key);
  assert.ok(process.env.TMPDIR.length < 80);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const dashboard = path.join(root, 'components/dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(dashboard, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' }, observer: { enabled: false } }));
  fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Singapore\n');
  let mode = 'single', supervisor = true, running = true, health = 'ok', source = 'record', stale = false, scenario = 'normal';
  let server, auth, store, controlCalls = 0, requests = 0;
  const timers = [], stores = new Set(), readers = new Set();
  const previous = process.env.ZYLOS_DIR;
  t.after(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    for (const timer of timers) clearInterval(timer);
    for (const reader of readers) reader.close();
    for (const owned of stores) if (owned.db.open) owned.close();
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const interval = globalThis.setInterval, check = Store.prototype.checkSchema, open = C4Reader.prototype.open;
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = interval(...args); timers.push(timer); return timer; });
  t.mock.method(Store.prototype, 'checkSchema', function (...args) { stores.add(this); store = this; return check.apply(this, args); });
  if (open) t.mock.method(C4Reader.prototype, 'open', function (...args) { readers.add(this); return open.apply(this, args); });
  t.mock.method(CoreState.prototype, 'refresh', async function () { return this.getState(); });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.module('../src/lib/auth.js', { namedExports: {
    ...await import('../src/lib/auth.js'),
    AuthGate: class extends AuthGate { constructor(...args) { super(...args); auth = this; } },
  } });
  const execute = async (file, args) => {
      assert.equal(file, process.execPath);
      assert.equal(args[0], path.join(root, '.claude/skills/comm-bridge/scripts/c4-control.js'));
      assert.equal(args[1], 'enqueue');
      assert.equal(args[args.indexOf('--target-run') + 1], stale ? 'old-run' : 'current-run');
      assert.equal(args.includes('--group'), mode !== null);
      if (mode !== null) assert.equal(args[args.indexOf('--group') + 1], 'origin');
      controlCalls++;
      return { stdout: JSON.stringify(stale ? { ok: false, error: { code: 'TARGET_MISMATCH', runId: 'current-run' } } : { ok: true, data: { id: controlCalls } }) };
  };
  const execFile = () => assert.fail('Only bounded promisified controls are expected');
  execFile[promisify.custom] = execute;
  t.mock.module('node:child_process', { namedExports: { ...childProcess,
    execFileSync: (_file, args) => { assert.deepEqual(args, ['--version']); return '1.0.0'; }, execFile,
  } });
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (['runtime/descriptors.js', 'runtime/index.js', 'runtime/contract.js'].includes(name)) return import(new URL(`../../../cli/lib/${name}`, import.meta.url));
    if (name === 'config-store.js') return { readConfigStrict: () => ({ state: 'ok', config: { session_mode: mode, runtime: 'claude' } }) };
    if (name === 'config.js') return { readSessionMode: () => ({ mode, keyPresent: mode !== null }) };
    if (name === 'status-view.js') return { collectStatus: options => collectStatus({ ...options,
      configIssue: () => null, resolveRoot: () => root, requests: () => ({}), facts: () => ({ originNeed: null }),
    }) };
    if (name === 'session-mode-status.js') return { readSessionModeStatus: async () => ({}) };
    if (name === 'session-pool-config.js') return { readPoolCapacity: () => ({ k: 4 }) };
    if (name === 'session-hot-ttl.js') return { resolveSessionHotTtl: () => ({ seconds: 1800 }) };
    if (name === 'pm2.js') return { createPm2Helpers: () => ({}) };
    if (name === 'model-rotation-thresholds.js') return { readDefaultModels: () => ({}), readCodexModelWindows: () => ({}), modelThreshold: () => 80, thresholdLimit: () => 100 };
    if (name === 'session-usage-reader.js') return { usageModelFacts: () => ({}) };
    if (['config-lock.js', 'private-file.js'].includes(name)) return {};
    if (name === 'session-state-reader.js') return {
      readLiveIdentity: async () => ({ present: running }),
      readRuntimeHealth: async () => source === 'record' ? { health } : { [source]: true },
    };
    if (name === 'session-nudge.js') return { nudgeSession };
    if (name === 'am-sock-client.js') return { submit: async request => {
      if (request.version === 0) return supervisor ? { kind: 'rejected', reply: { code: 'invalid_request' } } : { kind: 'connect_failed' };
      assert.equal(request.type, 'manual_restart');
      assert.equal(request.expectedRunId, stale ? 'old-run' : 'current-run');
      if (stale) return { kind: 'rejected', reply: { result: 'stale_target', currentRunId: 'current-run' } };
      return { kind: 'accepted', reply: { result: 'accepted' } };
    } };
    assert.fail(`Unexpected Core module: ${name}`);
  } } });
  const snapshot = () => ({ readAt: Date.now(), mode, view: mode, listKnown: true,
    sources: {}, instance: { pool: { used: 4, capacity: 4 }, runtimeHealth: { claude: { health: 'rate_limited', cooldownUntil: Math.floor(Date.now() / 1000) + 60 } } },
    rows: [{ sessionGroup: mode === 'multi' ? 'origin' : null,
      presence: scenario === 'starting' || scenario === 'unknown' ? scenario : running ? 'running' : 'not_running',
      live: running ? { runtime: 'claude', runId: 'current-run', sessionId: 'current-session', status: { valid: true, state: 'busy' } } : null,
      createdAt: Math.floor(Date.now() / 1000),
      queue: { pending: { count: 2, oldestAt: Date.now() - 1000 } },
      noResponse: { since: Date.now() - 1000 }, tools: [],
      ...(scenario === 'waiting' ? { wait: { kind: 'pool_wait', position: 2 } } : {}),
      ...(scenario === 'failed' ? { wait: { kind: 'start_failed', count30m: 1, lastAt: Date.now() - 1000, reasonCode: 'launch_failed' } } : {}),
    }],
  });
  const { createGroupSnapshot } = await import('../src/lib/workbench/group-snapshot.js');
  const observations = () => new Map([[mode === 'multi' ? 'origin' : null, {
    identity: { present: running, ready: true, runtime: 'claude',
      runId: 'current-run', sessionId: 'current-session', createdAt: Math.floor(Date.now() / 1000) },
    status: { valid: true, value: { state: 'busy' }, sampledAt: Date.now() },
    usage: { valid: false },
  }]]);
  // Exercise the real snapshot and presence producers through HTTP. The remaining
  // synthetic scenarios isolate optional projection fields from their inputs.
  t.mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: {
    createGroupSnapshot: options => {
      const real = createGroupSnapshot({ ...options,
        cli: {
          runC4Db: async args => ({ ok: true, data: args[0] === 'groups' ? [] : { groups: [], globalFence: null } }),
          readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }),
        },
        sessionObservations: {
          get: async () => ({ mode, observations: observations() }),
          reader: { readRuntimeHealth: async () => ({ health: 'ok', publicHealth: 'ok' }), readAccountUsage: async () => null },
        },
        readChannels: async () => [],
      });
      return { ...real, getSnapshot: async () => {
        if (scenario !== 'source') return snapshot();
        return real.getSnapshot(Date.now(), { fresh: true });
      }, getCachedSnapshot: () => scenario === 'source' ? real.getCachedSnapshot() : snapshot() };
    },
  } });
  process.env.ZYLOS_DIR = root;
  console.log('Operations HTTP isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ,
    database: path.join(dashboard, 'dashboard.db'), transport: 'loopback only; Core/PM2/tmux inputs inert' }));
  const { createServer } = await import(`../src/index.js?operations=${Date.now()}`);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, token, body) => {
    requests++;
    const response = await fetch(base + route, { signal: AbortSignal.timeout(3000),
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/instance')).status, 401);
  assert.equal((await request('/api/auth/token', 'zylos_ak_invalid', {})).status, 401);
  const tokens = {};
  for (const scope of ['read', 'admin']) {
    const key = generateApiKey();
    store.insertApiKey({ name: `fixture-${scope}`, keyHash: hashApiKey(key), scope });
    const exchange = await request('/api/auth/token', key, {});
    assert.equal(exchange.status, 200);
    assert.equal(exchange.body.ok, true);
    assert.match(exchange.body.token, /^zylos_st_[a-f0-9]{64}$/);
    assert.equal(exchange.body.scope, scope);
    assert.equal(exchange.body.ttl_seconds, 86400);
    iso(exchange.body.expires_at);
    tokens[scope] = exchange.body.token;
  }
  for (mode of ['single', 'multi']) {
    fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ session_mode: mode }));
    scenario = 'source';
    for (const token of [tokens.read, tokens.admin]) {
      const instance = await request('/api/instance', token);
      assert.equal(instance.status, 200, JSON.stringify(instance.body));
      assert.equal(instance.body.session_mode.sessionMode, mode);
      const origin = await request('/api/groups/origin?include=', token);
      assert.equal(origin.status, 200, JSON.stringify(origin.body));
      assert.equal(origin.body.presence, 'running');
      assert.equal(origin.body.run.runId, 'current-run');
    }
    scenario = 'normal';
    for (const token of [undefined, tokens.read, tokens.admin]) {
      const live = await request('/api/health', token);
      assert.equal(live.status, 200); assert.equal(live.body.ok, true);
      assert.equal(live.body.service, 'zylos-dashboard'); assert.equal(typeof live.body.bootId, 'string');
      const ready = await request('/api/health/ready', token);
      assert.equal(ready.status, 200); assert.equal(ready.body.ready, true); assert.equal(ready.body.reason, null);
      assert.equal(ready.body.session_mode, mode);
      assert.equal(ready.body.session_running, null, 'readiness does not observe session presence');
      for (const runtime of ['claude', 'codex']) assert.deepEqual(ready.body.runtime_health[runtime], { source: 'record', health: 'ok' });
    }
    for (const scope of ['read', 'admin']) {
      const token = tokens[scope];
      const instance = await request('/api/instance', token);
      assert.equal(instance.status, 200); assert.equal(instance.body.session_mode.sessionMode, mode);
      assert.equal(typeof instance.body.agent.name, 'string'); assert.equal(typeof instance.body.default_runtime, 'string');
      const detail = await request('/api/groups/origin?include=', token);
      assert.equal(detail.status, 200); assert.equal(detail.body.presence, 'running');
      assert.equal(detail.body.state.kind, 'working');
      assert.equal(detail.body.run.runId, 'current-run'); assert.equal(detail.body.run.sessionId, 'current-session'); iso(detail.body.run.createdAt);
      assert.equal(detail.body.flags.queued.count, 2); iso(detail.body.flags.queued.oldestAt);
      assert.equal(typeof detail.body.flags.queued.waitSeconds, 'number'); iso(detail.body.flags.noResponse.since);
      assert.equal(detail.body.flags.blocked.reason, 'rate_limited');
      assert.equal(detail.body.flags.blocked.runtime, 'claude'); iso(detail.body.flags.blocked.recoveryAt);
      const counts = await request('/api/groups/counts', token);
      assert.equal(counts.status, 200); iso(counts.body.readAt); assert.equal(counts.body.listKnown, true);
      assert.equal(typeof counts.body.running.total, 'number');
      for (const key of states) assert.equal(typeof counts.body.running.states[key], 'number');
      for (const key of flags) assert.equal(typeof counts.body.running.flags[key], 'number');
      for (const key of ['total', 'waitingSlot', 'startFailed']) assert.equal(typeof counts.body.offline[key], 'number');
      for (const key of ['used', 'capacity']) assert.equal(typeof counts.body.pool[key], 'number');
      const usage = await request('/api/usage/summary', token);
      assert.equal(usage.status, 200); assert.equal(usage.body.tz, 'Asia/Singapore');
      assert.equal(usage.body.tzFallback, false); assert.equal(usage.body.scope, 'all_groups');
      for (const period of ['today', 'sevenDay']) {
        const value = usage.body[period]; iso(value.since); iso(value.until);
        for (const row of [value, value.byRuntime.claude, value.byRuntime.codex]) {
          for (const key of ['tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cost']) assert.equal(typeof row[key], 'number');
          assert.ok(row.cacheHitRate === null || typeof row.cacheHitRate === 'number');
        }
      }
      for (const action of ['interrupt', 'chop-chop', 'restart']) {
        const result = await request(`/api/groups/origin/actions/${action}`, token, { runId: detail.body.run.runId, sessionId: detail.body.run.sessionId });
        if (scope === 'read') { assert.equal(result.status, 403); assert.equal(result.body.error.code, 'insufficient_scope'); continue; }
        assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
        assert.equal(result.body.submission, action === 'restart' ? 'accepted' : 'submitted');
        if (action === 'restart') assert.equal(typeof result.body.requestId, 'string');
        else { assert.equal(typeof result.body.controlId, 'number'); assert.equal(result.body.rejectionCode, null); assert.equal(result.body.currentRunId, null); }
      }
    }
    for (const action of ['interrupt', 'chop-chop']) {
      const missing = await request(`/api/groups/origin/actions/${action}`, tokens.admin, {});
      assert.equal(missing.status, 400); assert.equal(missing.body.ok, false); assert.equal(missing.body.error.code, 'TARGET_REQUIRED');
    }
    stale = true;
    const rejected = await request('/api/groups/origin/actions/interrupt', tokens.admin, { runId: 'old-run' });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.ok, false);
    assert.equal(rejected.body.submission, 'rejected'); assert.equal(rejected.body.controlId, null);
    assert.equal(rejected.body.error.code, 'TARGET_MISMATCH'); assert.equal(rejected.body.rejectionCode, 'TARGET_MISMATCH');
    assert.equal(rejected.body.currentRunId, 'current-run');
    const restartRejected = await request('/api/groups/origin/actions/restart', tokens.admin, { runId: 'old-run' });
    assert.equal(restartRejected.status, 409); assert.equal(restartRejected.body.ok, false);
    assert.equal(restartRejected.body.submission, 'rejected');
    assert.equal(typeof restartRejected.body.requestId, 'string');
    assert.equal(restartRejected.body.error.code, 'stale_target');
    assert.equal(restartRejected.body.currentRunId, 'current-run'); stale = false;
    supervisor = false;
    const unavailable = await request('/api/health/ready');
    assert.equal(unavailable.status, 503); assert.equal(unavailable.body.ready, false);
    assert.equal(unavailable.body.reason, 'supervisor_unavailable'); assert.equal(unavailable.body.session_mode, mode);
    assert.equal(unavailable.body.session_running, null);
    for (const runtime of ['claude', 'codex']) assert.deepEqual(unavailable.body.runtime_health[runtime], { source: 'record', health: 'ok' });
    supervisor = true;
    for (scenario of ['starting', 'unknown', 'waiting', 'failed']) {
      running = scenario !== 'waiting' && scenario !== 'failed';
      for (const scope of ['read', 'admin']) {
        const result = await request('/api/groups/origin?include=', tokens[scope]);
        assert.equal(result.status, 200);
        const row = result.body;
        if (scenario === 'starting') { assert.equal(row.presence, 'starting'); assert.equal(row.state.kind, 'starting'); }
        if (scenario === 'unknown') {
          assert.equal(row.presence, 'unknown'); assert.equal(row.state.kind, 'unknown');
          assert.ok(Array.isArray(row.flags.unreadable.reasons));
          assert.ok(row.flags.unreadable.reasons.length > 0);
          for (const reason of row.flags.unreadable.reasons) assert.equal(typeof reason, 'string');
        }
        if (scenario === 'waiting') { assert.equal(row.presence, 'not_running'); assert.equal(row.state.kind, 'offline'); assert.equal(row.flags.waitingSlot.position, 2); }
        if (scenario === 'failed') {
          assert.equal(row.flags.startFailed.count, 1); iso(row.flags.startFailed.lastAt);
          assert.equal(row.flags.startFailed.reason, 'launch_failed');
        }
      }
    }
    scenario = 'normal'; running = true;
  }
  // A pre-mode instance reports effective single mode with an independent group presence.
  mode = null; running = false;
  const absent = await request('/api/health/ready');
  assert.equal(absent.status, 200); assert.equal(absent.body.ready, true);
  assert.equal(absent.body.reason, null); assert.equal(absent.body.session_running, null);
  assert.equal(absent.body.session_mode, 'single');
  const offline = (await request('/api/groups/origin?include=', tokens.read)).body;
  assert.equal(offline.presence, 'not_running'); assert.equal(offline.state.kind, 'offline'); assert.equal(offline.run, null);
  running = true;
  for (health of healthStates) {
    const result = await request('/api/health/ready');
    assert.equal(result.status, 200);
    for (const runtime of ['claude', 'codex']) assert.deepEqual(result.body.runtime_health[runtime], { source: 'record', health });
  }
  for (source of ['missing', 'unreadable']) {
    const result = (await request('/api/health/ready')).body;
    for (const runtime of ['claude', 'codex']) { assert.equal(result.runtime_health[runtime].source, source); assert.equal(result.runtime_health[runtime].health, null); }
    nullableString(result.reason);
  }
  assert.ok(auth && controlCalls > 0);
  console.log(`Operations contract observations: ${requests} HTTP requests; ${controlCalls} isolated controls; single and multi modes`);
});
