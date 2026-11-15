import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { CoreState } from '../skills/dashboard/src/lib/core-state.js';
import { MetricResolver } from '../skills/dashboard/src/lib/metric-resolver.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { generateApiKey, hashApiKey } from '../skills/dashboard/src/lib/auth.js';
import { createGroupSnapshot, workbenchResponse, systemSample } from '../skills/dashboard/src/lib/workbench/group-snapshot.js';

// Actual HTTP/auth/database and Workbench cache/projection boundary, with deterministic
// Core, C4 and cost observations. Run when agent-status routing, auth or mode semantics
// change; unrelated presentation changes may skip. Use the Node runner: it isolates
// HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR before imports. No collectors, runtime,
// tmux or remote Fleet agents start; cgroup construction uses a fixture (no /sys
// reads), HTTPS is blocked, and HTTP binds only loopback.
test('agent-status HTTP preserves authentication and single/multi observation semantics', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'));
  const data = path.join(root, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.mkdirSync(path.join(root, 'activity-monitor'));
  fs.writeFileSync(path.join(root, 'activity-monitor/restart-requests.json'), '[]');
  const coreConfig = path.join(root, '.zylos/config.json');
  let mode = 'single', now = Date.now(), groupState = 'busy', listKnown = true;
  let originActivity = 'idle', originHealth = null, useRealCore = false;
  let statusReads = 0, nullQuotas = false, cgroupConstructions = 0;
  const writeMode = value => {
    mode = value;
    fs.writeFileSync(coreConfig, JSON.stringify({ session_mode: value }));
    now += 3000; // Expire the real Workbench cache without sleeping or polling.
  };
  writeMode('single');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    auth: { enabled: true, password: 'fixture-password' }, fleet: { agents: [] },
  }));
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  const realGet = https.get;
  https.get = () => {
    const request = Object.assign(new EventEmitter(), { destroy() {}, end() {} });
    setImmediate(() => request.emit('error', new Error('offline fixture')));
    return request;
  };
  let server;
  t.after(async () => {
    https.get = realGet;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  console.log('Agent status isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, tmux: 'not used',
    network: 'loopback HTTP only; HTTPS blocked; no remote agents' }));
  const originState = () => ({ state: originActivity.toUpperCase(), runtime: 'claude', ready: true, sampledAt: now,
    reason: null, sessionId: 'fixture-session', runId: 'fixture-run', running_tools: [],
    active_subagents: [], subagent_tools: [], source: {}, updated_at: new Date(now).toISOString() });
  const realCore = Object.fromEntries(['refresh', 'getState', 'getUsageObservation']
    .map(name => [name, CoreState.prototype[name]]));
  const readinessObservation = () => ({
    observation: { identity: { present: true, ready: true, sessionId: 'fixture-session' },
      status: { valid: true, value: { state: originActivity } } }, view: null, runtimeHealth: originHealth,
  });
  t.mock.method(CoreState.prototype, 'refresh', async function (options = {}) {
    if (useRealCore) return realCore.refresh.call(this, options);
    return options.readiness ? { snapshot: originState(), readinessObservation: readinessObservation(), sessionMode: mode } : originState();
  });
  t.mock.method(CoreState.prototype, 'getState', function () {
    return useRealCore ? realCore.getState.call(this) : originState();
  });
  t.mock.method(CoreState.prototype, 'getUsageObservation', function () {
    return useRealCore ? realCore.getUsageObservation.call(this) : { valid: true, value: {
      model: { id: 'fixture-model', display_name: 'Fixture model' }, context_window: { used_percentage: 37 },
    } };
  });
  t.mock.method(MetricResolver.prototype, 'resolveAggregated', metric =>
    ['cost', 'session_cost'].includes(metric) ? { session: 1.25, today: 4.5, seven_day: 12.75 } : null);
  // Install before importing SystemCollector: its constructor eagerly seeds the
  // cgroup collector even though this test supplies cached system observations.
  t.mock.module('../skills/dashboard/src/lib/cgroup-resources.js', { namedExports: {
    createCgroupCollector: () => {
      cgroupConstructions++;
      return { sample() {}, read: () => ({ cpu_pct: null, mem_pct: null }) };
    },
  } });
  const { SystemCollector } = await import('../skills/dashboard/src/lib/collectors/system-collector.js');
  t.mock.method(SystemCollector.prototype, 'getLatestSystemData', () => ({
    collectedAt: now, resource_scope: 'container', cpu_pct: nullQuotas ? null : 12, mem_pct: nullQuotas ? null : 25,
    mem_used_bytes: nullQuotas ? null : 256, mem_total_bytes: nullQuotas ? null : 1024,
    disk_used_pct: 40, disk_free_bytes: 2048,
  }));
  const coreModules = async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
    if (name === 'status-view.js') return { collectStatus: async () => { statusReads++; return { view: 'multi',
      origin: { presence: 'not_running' }, groupListError: listKnown ? null : 'unreadable', runtimeHealth: {}, supervisorPaused: false,
      groups: listKnown ? [{ sessionGroup: 'fixture-group', presence: 'running', runtime: 'claude',
        status: groupState === 'unknown' ? { valid: false, reason: 'unreadable' } : { valid: true, state: groupState } }] : [],
    }; } };
    if (name === 'session-state-reader.js') return { readAccountUsage: async () => null };
    if (name === 'session-pool-config.js') return { readPoolCapacity: () => ({ k: 12, record: null, valid: true, fresh: true }) };
    throw new Error(`Unexpected Core module ${name}`);
  };
  t.mock.module('../skills/dashboard/src/lib/workbench/group-snapshot.js', { namedExports: {
    workbenchResponse, systemSample,
    createGroupSnapshot: options => createGroupSnapshot({ ...options, now: () => now, loadCoreModule: coreModules,
      c4Reader: { listSlotOccupancy: () => [] },
      cli: { runC4Db: async () => ({ ok: true, data: { groups: [], hasOlder: false } }),
        readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) } }),
  } });
  const { createServer } = await import('../skills/dashboard/src/index.js');
  assert.equal(cgroupConstructions, 1, 'the real SystemCollector construction uses only the cgroup fixture');
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Auth boundary uses the real persisted API-key -> API-session exchange,
  // rather than bypassing the gate or treating a raw key as a session token.
  await t.test('unauthenticated reads fail and a read-scope API session succeeds', async () => {
    for (const route of ['/api/state', '/api/agent-status']) {
      assert.equal((await fetch(`${origin}${route}`)).status, 401);
    }
  });
  const store = new Store(path.join(data, 'dashboard.db'));
  const key = generateApiKey();
  try { store.insertApiKey({ name: 'agent-status-read', keyHash: hashApiKey(key), scope: 'read' }); }
  finally { store.close(); }
  const exchanged = await fetch(`${origin}/api/auth/token`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
  assert.equal(exchanged.status, 200);
  const { token, scope } = await exchanged.json();
  assert.equal(scope, 'read');
  const headers = { Authorization: `Bearer ${token}` };
  const read = async route => {
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await read('/api/state')).context_pct, 37);

  await t.test('single mode preserves session context and costs in the versioned contract', async () => {
    const value = await read('/api/agent-status');
    assert.equal(value.schema_version, 1);
    assert.equal(value.session_mode, 'single');
    assert.ok(value.sampled_at);
    assert.deepEqual(value.readiness, { ready: true, observable: true, stage: 'ready', reason: 'ready' });
    assert.equal(value.runtime.runtime, 'claude');
    assert.equal(value.runtime.model_id, 'fixture-model');
    assert.deepEqual(value.resources, { scope: 'container', cpu_pct: 12, mem_pct: 25,
      mem_used_bytes: 256, mem_total_bytes: 1024, disk_pct: 40, disk_free_bytes: 2048 });
    assert.deepEqual((await read('/api/state')).system_metrics, value.resources,
      'legacy and machine APIs publish the same container resource observation');
    assert.equal(value.context_pct, 37);
    assert.deepEqual(value.cost, { session: 1.25, daily: 4.5, weekly: 12.75 });
  });

  // Both modes use the same Core identity/status observation. Only single
  // mode's busy session withholds readiness after a session is established.
  await t.test('single busy readiness comes from the Core session observation', async () => {
    originActivity = 'busy';
    const value = await read('/api/agent-status');
    assert.equal(value.state, 'BUSY');
    assert.deepEqual(value.readiness, { ready: false, observable: true, stage: 'session_ready', reason: 'busy' });
    originActivity = 'idle';
  });

  // Malformed config crosses HTTP -> real CoreState.refresh/_read -> the real
  // strict config reader. No session reader or tmux call is reached after rejection.
  // Run for config failure or readiness changes; presentation-only changes may skip.
  await t.test('unreadable mode returns single structure with unavailable Core observations', async () => {
    const { CONFIG_FILE } = await import('../cli/lib/config.js');
    assert.equal(CONFIG_FILE, coreConfig, 'the strict reader targets only the isolated config');
    fs.writeFileSync(coreConfig, '{ unreadable JSON');
    useRealCore = true;
    try {
      const value = await read('/api/agent-status');
      assert.equal(value.session_mode, 'single');
      assert.equal(value.groups, null);
      assert.equal(value.state, 'UNKNOWN');
      assert.equal(value.context_pct, null);
      assert.deepEqual(value.readiness, { ready: false, observable: false, stage: 'runtime_down', reason: 'status_missing' });
    } finally {
      useRealCore = false;
      writeMode('single');
    }
  });

  // This exercises API -> actual Workbench classification/cache -> instance
  // summary. Origin stays IDLE throughout, so group activity must determine
  // multi mode. A known list can contain unknown group observations, while
  // an unavailable list leaves the instance state UNKNOWN.
  await t.test('multi mode follows Workbench groups and withholds session-only values', async () => {
    writeMode('multi');
    for (const state of ['busy', 'idle', 'unknown']) {
      groupState = state;
      now += 30_001;
      const value = await read('/api/agent-status');
      const collected = statusReads;
      assert.ok(collected > 0);
      const repeated = await read('/api/agent-status');
      assert.equal(statusReads, collected, 'consecutive machine-status reads reuse the Workbench snapshot');
      assert.deepEqual(repeated.groups, value.groups);
      assert.equal(value.schema_version, 1);
      assert.equal(value.session_mode, 'multi');
      assert.equal(value.state, state === 'busy' ? 'BUSY' : 'IDLE');
      assert.equal(value.groups[state], 1);
      assert.deepEqual(value.readiness, { ready: true, observable: true, stage: 'ready', reason: 'ready' });
      assert.equal(value.context_pct, null);
      assert.deepEqual(value.cost, { session: null, daily: 4.5, weekly: 12.75 });
    }
    listKnown = false;
    now += 30_001;
    const unavailable = await read('/api/agent-status');
    assert.equal(unavailable.state, 'UNKNOWN');
    assert.equal(unavailable.context_pct, null);
    assert.equal(unavailable.cost.session, null);
  });

  // Actual HTTP -> request cache age -> Workbench builder; only source inputs
  // and the clock are fixtures. Run for cache policy or readiness route changes;
  // unrelated presentation changes may skip. Same private environment as above.
  await t.test('machine status reuses groups for thirty seconds while readiness stays current', async () => {
    writeMode('multi');
    listKnown = true;
    groupState = 'busy';
    now += 30_001;
    const before = statusReads;
    const first = await read('/api/agent-status');
    assert.equal(statusReads, before + 1, 'an expired snapshot invokes the real builder');
    assert.equal(first.state, 'BUSY');
    assert.equal(first.groups.busy, 1);
    assert.equal(first.readiness.ready, true);
    const builtAt = now;
    groupState = 'idle';
    for (const age of [2001, 10_000, 29_999]) {
      now = builtAt + age;
      const cached = await read('/api/agent-status');
      assert.equal(statusReads, before + 1, `no rebuild at age ${age}`);
      assert.equal(cached.state, 'BUSY');
      assert.equal(cached.groups.busy, 1);
    }
    originHealth = { health: 'auth_failed' };
    const blocked = await read('/api/agent-status');
    assert.equal(statusReads, before + 1, 'readiness change does not rebuild groups');
    assert.equal(blocked.state, 'BUSY');
    assert.equal(blocked.readiness.reason, 'health_auth_failed');
    assert.equal(blocked.readiness.ready, false);
    originHealth = null;
    assert.equal((await read('/api/agent-status')).readiness.ready, true);
    assert.equal(statusReads, before + 1);

    now = builtAt + 30_001;
    const rebuilt = await read('/api/agent-status');
    assert.equal(statusReads, before + 2, 'a request past thirty seconds rebuilds');
    assert.equal(rebuilt.state, 'IDLE');
    assert.equal(rebuilt.groups.idle, 1);

    // The page retains its independent two-second read policy on the same cache.
    groupState = 'busy';
    now += 2001;
    const page = await read('/api/workbench/groups');
    assert.equal(statusReads, before + 3, 'the page still rebuilds after two seconds');
    assert.equal(page.counts.busy, 1);
    const reusedPage = await read('/api/agent-status');
    assert.equal(statusReads, before + 3, 'machine status reuses the newer page snapshot');
    assert.equal(reusedPage.state, 'BUSY');
    assert.equal(reusedPage.groups.busy, 1);
  });

  // Unlimited/unreadable container quotas remain null through both HTTP
  // projections; an absent quota must not turn into a host or zero gauge.
  await t.test('both API resource mappings preserve null container quota fields', async () => {
    nullQuotas = true;
    const value = await read('/api/agent-status');
    assert.deepEqual(value.resources, { scope: 'container', cpu_pct: null, mem_pct: null,
      mem_used_bytes: null, mem_total_bytes: null, disk_pct: 40, disk_free_bytes: 2048 });
    assert.deepEqual((await read('/api/state')).system_metrics, value.resources);
  });
});
