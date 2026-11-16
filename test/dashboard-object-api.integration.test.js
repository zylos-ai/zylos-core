import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import Database from '../skills/comm-bridge/scripts/sqlite-driver.js';
import { CoreState } from '../skills/dashboard/src/lib/core-state.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { generateApiKey, hashApiKey, hashPassword } from '../skills/dashboard/src/lib/auth.js';
import { createGroupSnapshot, systemSample } from '../skills/dashboard/src/lib/workbench/group-snapshot.js';
import { loadCoreModule as originalLoadCoreModule } from '../skills/dashboard/src/lib/core-modules.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';
import { populateSchedulePagination } from '../skills/dashboard/__tests__/fixtures/schedule-pagination.js';
import { SseHub } from '../skills/dashboard/src/lib/sse.js';
import { claudeProjectSlug } from '../skills/dashboard/src/lib/claude-project-path.js';

// Real HTTP, auth, SQLite, group projection and usage boundary. Run when these
// object routes or authorization rules change; skip unrelated presentation work.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR before any
// import. This fixture owns its root and DBs; no runtime, PM2 or tmux is started.
// Action/deletion/CLI/IPC adapters are deterministic; HTTP binds loopback only,
// HTTPS and every other child process are rejected. Teardown closes streams,
// server connections and DB handles before deleting only this fixture's root.
test('dashboard object APIs expose both modes and reject retired routes and unauthorized writes', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-objects-'));
  const data = path.join(root, 'components/dashboard');
  for (const dir of [data, path.join(root, '.zylos'), path.join(root, 'activity-monitor'), path.join(root, 'comm-bridge')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Singapore\n');
  fs.writeFileSync(path.join(root, 'activity-monitor/restart-requests.json'), '[]');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('fixture-password') }, fleet: { agents: [{ name: 'remote-fixture', base_url: 'http://127.0.0.1:1', read_api_key: 'fixture' }] }, chat: { allowRemote: true } }));
  const configFile = path.join(root, '.zylos/config.json');
  let usageVersion = '1.0.0', usageModel = 'fixture-model', usageEffort = 'high', modeStatusReadable = true, originRun = 'fixture-run';
  let mode = 'single', clock = Date.now(), server, seedStore, catalogReadable = true;
  const actionCalls = [], cliCalls = [], records = [];
  const savedRoot = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  const writeMode = next => { mode = next; clock += 3000; fs.writeFileSync(configFile, JSON.stringify({ session_mode: mode, runtime: 'claude' })); };
  writeMode('single');
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  c4.exec(`CREATE TABLE conversations(id INTEGER PRIMARY KEY,timestamp TEXT,direction TEXT,channel TEXT,endpoint_id TEXT,content TEXT,session_group TEXT,status TEXT);
    CREATE TABLE slot_occupancy(session_group TEXT,run_id TEXT,state TEXT,held_until INTEGER,created_at INTEGER);`);
  c4.prepare('INSERT INTO conversations VALUES(1,?,?,?,?,?,?,?)').run(new Date().toISOString(), 'in', 'telegram', 'fixture', 'Fixture message', 'telegram:working', 'delivered');
  c4.close();
  fs.mkdirSync(path.join(root, 'memory')); fs.writeFileSync(path.join(root, 'memory/example.md'), '# Fixture memory\n');
  fs.mkdirSync(path.join(root, 'scheduler'));
  const scheduler = new Database(path.join(root, 'scheduler/scheduler.db'));
  populateSchedulePagination(scheduler); scheduler.close();
  const previousGet = https.get;
  https.get = () => {
    const request = Object.assign(new EventEmitter(), { destroy() {}, end() {} });
    setImmediate(() => request.emit('error', new Error('HTTPS blocked by isolated fixture')));
    return request;
  };
  t.after(async () => {
    https.get = previousGet;
    if (server) { await server.closeAttachments?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    seedStore?.close();
    if (savedRoot === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = savedRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.ok(root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Dashboard object API isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, root, database: path.join(data, 'dashboard.db'), c4: path.join(root, 'comm-bridge/c4.db'),
    tmux: 'none; no subprocess allowed', IPC: 'injected', network: 'loopback HTTP only; HTTPS blocked' }));

  const catalog = () => ['origin', 'telegram:working', 'telegram:child', ...Array.from({ length: 57 }, (_, i) => `telegram:offline-${i}`)]
    .map(sessionGroup => ({ sessionGroup, componentName: sessionGroup === 'origin' ? null : 'telegram', sessionGroupName: sessionGroup.split(':')[1],
      lastActivityAt: clock - (sessionGroup.includes('offline') ? 9 * 86400000 : 1000), preview: {
        timestamp: clock - (sessionGroup === 'telegram:working' ? 100 : 1000),
        text: sessionGroup === 'telegram:working' ? 'Latest channel message' : 'Fixture message',
        message: sessionGroup === 'telegram:working' ? 'Latest channel message' : 'Fixture message',
        messageSource: sessionGroup === 'telegram:working' ? { kind: 'header' } : undefined,
        messageRaw: sessionGroup === 'telegram:working' ? '[Telegram fixture] Latest channel message' : 'Fixture first message' } }));
  const cli = { runC4Db: async args => {
    cliCalls.push(args);
    if (!catalogReadable && args[0] === 'groups') return { ok: false, reason: 'fixture_catalog_failed' };
    return { ok: true, data: args[0] === 'groups' ? args.includes('--raw') ? catalog().filter(row => row.sessionGroup === args[2]) : args.includes('--active-since') ? { groups: catalog(), hasOlder: false } : catalog()
      : args[0] === 'unsummarized' ? { count: 0, firstAt: null } : { groups: [{ sessionGroup: 'telegram:working', pending: { count: 3, oldestAt: clock - 1000, head: { id: 1, priority: 0 } }, running: { count: 0 } }], globalFence: null } };
  }, readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) };
  const fakeExecute = (file, args, options, callback) => {
    if (typeof options === 'function') callback = options;
    cliCalls.push([String(file), ...args]);
    let data;
    if (file === 'zylos' && args[0] === 'group' && args[1] === 'overrides') data = { baseline: { runtime: 'claude' }, runtime: [], model: [], runtimeTotal: 0, nextAfter: null };
    else if (file === 'zylos' && args[0] === 'group') data = { resolved: args[1] === 'runtime' ? { runtime: 'claude' } : { runtime: 'claude', mode: 'default' } };
    else if (file === process.execPath && args[0]?.endsWith('/c4-control.js') && args[1] === 'enqueue') data = { id: 7 };
    else if (file === process.execPath && args[0]?.endsWith('/scheduler/scripts/cli.js')) { callback(null, JSON.stringify({ ok: true, data: { id: 'fixture-task' } }), ''); return new EventEmitter(); }
    else if (file === process.execPath && args[0]?.endsWith('/sync-lock.js')) { callback(null, JSON.stringify({ sync: { held: false } }), ''); return new EventEmitter(); }
    else throw new Error(`Unexpected child process in HTTP fixture: ${file} ${args[0]}`);
    callback(null, JSON.stringify({ ok: true, data }), ''); return new EventEmitter();
  };
  fakeExecute[Symbol.for('nodejs.util.promisify.custom')] = (file, args, options) => new Promise((resolve, reject) => {
    fakeExecute(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  t.mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fakeExecute,
    execFileSync: () => { throw new Error('Synchronous child processes are forbidden in HTTP fixture'); } } });
  t.mock.module('../skills/dashboard/src/lib/installed-versions.js', { namedExports: { createInstalledVersionReader: () => async () => ({ zylos: 'fixture', claude: '1.0.0', codex: '1.0.0' }) } });
  const actions = await import('../skills/dashboard/src/lib/actions.js');
  t.mock.module('../skills/dashboard/src/lib/actions.js', { namedExports: { ...actions,
    handleAction: async (action, body) => { actionCalls.push({ action, body }); return { ok: true, action }; } } });
  t.mock.module('../skills/dashboard/src/lib/workbench/core-cli.js', { namedExports: { createCoreCli: () => cli } });
  const names = await import('../skills/dashboard/src/lib/workbench/display-names.js');
  t.mock.module('../skills/dashboard/src/lib/workbench/display-names.js', { namedExports: { ...names,
    createDisplayNames: options => names.createDisplayNames({ ...options, runC4Db: cli.runC4Db }),
  } });
  t.mock.module('../skills/dashboard/src/lib/workbench/group-actions.js', { namedExports: {
    createGroupActions: () => async (key, action, body) => { actionCalls.push({ key, action, body }); return { ok: true, action, submission: 'submitted' }; },
  } });
  const deletion = await import('../skills/dashboard/src/lib/workbench/group-deletion.js');
  t.mock.module('../skills/dashboard/src/lib/workbench/group-deletion.js', { namedExports: { ...deletion,
    createGroupDeletionRoutes: options => deletion.createGroupDeletionRoutes({ ...options, core: async (target, options) => {
      actionCalls.push({ deletion: target, preview: options.preview }); return { ok: true, preview: options.preview, operationId: 'fixture-operation', cutoffId: 1 };
    } }),
  } });
  const reader = { readSessionState: async key => ({ identity: { present: key === null || ['origin', 'telegram:working', 'telegram:child'].includes(key), ready: true,
    runtime: 'claude', runId: key === null || key === 'origin' ? originRun : 'fixture-run', sessionId: 'fixture-session', createdAt: clock / 1000 - 10, launchConfig: { runtime: 'claude', mode: 'default' } },
    status: { valid: true, sampledAt: clock, value: { state: key === 'telegram:working' ? 'busy' : 'idle' } },
    usage: { valid: true, value: { version: usageVersion, effort: { level: usageEffort }, model: { id: usageModel }, context_window: { used_percentage: 25 } } } }),
    readLiveIdentity: async () => ({ present: true, ready: true }), readRuntimeHealth: async () => ({ missing: true }), readAccountUsage: async () => null };
  const core = async name => {
    if (name === 'config.js') return { ...await originalLoadCoreModule(name), readSessionMode: () => ({ mode }) };
    if (name === 'am-sock-client.js') return { submit: async () => ({ kind: 'rejected', reply: { code: 'invalid_request' } }),
      lookupRestartRequest: async (requestId, options) => {
        assert.equal(options.sessionGroup, 'origin', 'the request lookup is bound to the group named in the HTTP path');
        assert.equal(requestId, '11111111-1111-4111-8111-111111111111');
        return 'done';
      } };
    if (name === 'session-mode-status.js') return { readSessionModeStatus: options => { if (!modeStatusReadable) throw Object.assign(new Error('fixture status failure'), { code: 'FIXTURE_UNREADABLE' }); return readSessionModeStatus({ ...options,
      db: { getModeTransition: async () => ({ run_id: 'fixture-transition', source_mode: 'single', target_mode: 'multi', phase: 'draining', reason: 'fixture-block', created_at: Math.floor(clock / 1000) - 1, updated_at: Math.floor(clock / 1000) }),
        getDrainFence: async () => null, getLastCompletedModeTransition: async () => null },
      readEvents: () => [{ run_id: 'fixture-transition', event: 'transition_blocked', reason: 'fixture-block', ts: clock - 1000 }],
      probeSupervisor: async () => false }); } };
    if (name === 'session-state-reader.js') return reader;
    return originalLoadCoreModule(name);
  };
  t.mock.module('../skills/dashboard/src/lib/core-modules.js', { namedExports: { loadCoreModule: core } });
  const originState = () => ({ state: 'IDLE', runtime: 'claude', ready: true, sampledAt: clock, sessionId: 'fixture-session', runId: 'fixture-run',
    running_tools: [], active_subagents: [], subagent_tools: [], source: {}, updated_at: new Date(clock).toISOString() });
  t.mock.method(CoreState.prototype, 'refresh', async () => originState());
  t.mock.method(CoreState.prototype, 'getState', originState);
  t.mock.method(CoreState.prototype, 'getUsageObservation', () => ({ valid: true, value: { model: { id: 'fixture-model' }, context_window: { used_percentage: 25 } } }));
  t.mock.module('../skills/dashboard/src/lib/cgroup-resources.js', { namedExports: { createCgroupCollector: () => ({ sample() {}, read: () => ({}) }) } });
  const { SystemCollector } = await import('../skills/dashboard/src/lib/collectors/system-collector.js');
  t.mock.method(SystemCollector.prototype, 'getLatestSystemData', () => ({ collectedAt: clock, resource_scope: 'container', cpu_source: 'container', mem_source: 'container', disk_total_bytes: 4096, cpu_pct: 20, cpu_count: 2, mem_pct: 25, mem_used_bytes: 256, mem_total_bytes: 1024, disk_used_pct: 40, disk_free_bytes: 2048 }));
  const { collectStatus } = await import('../cli/lib/status-view.js');
  t.mock.module('../skills/dashboard/src/lib/workbench/group-snapshot.js', { namedExports: { systemSample,
    createGroupSnapshot: options => createGroupSnapshot({ ...options, now: () => clock, cli,
      loadCoreModule: async name => name === 'status-view.js' ? { collectStatus: options => collectStatus({ ...options,
        mode: () => ({ mode }), resolveRoot: () => root, configIssue: () => null, requests: () => [], now: () => clock,
        list: () => [{ sessionGroup: 'telegram:working' }, { sessionGroup: 'telegram:child' }],
        facts: () => ({ originNeed: null }), health: () => ({ health: 'rate_limited', cooldownUntil: clock / 1000 + 60, updatedAt: clock }),
      }) } : name === 'config.js' ? { readSessionMode: () => ({ mode }) }
        : name === 'session-pool-config.js' ? { readPoolCapacity: () => ({ k: 3, valid: true, fresh: true }) } : core(name),
    }),
  } });
  const { writeMemory } = await import('../skills/zylos-memory/scripts/memory-write.js');
  t.mock.module('../skills/dashboard/src/lib/workbench/memory-write.js', { namedExports: {
    createMemoryWriter: () => (rel, { text, sha256 }) => writeMemory({ path: rel, sha256, content: text, env: { HOME: process.env.HOME, ZYLOS_DIR: root } }, { currentRunId: async () => null }),
    executeMemoryWrite: () => { throw new Error('CLI transport is replaced by the real in-process memory writer in this fixture'); },
  } });
  const { createServer } = await import('../skills/dashboard/src/index.js');
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  seedStore = new Store(path.join(data, 'dashboard.db'));
  seedStore.insertEvent({ id: 'fixture-child', ingest_id: 'fixture-child', timestamp: new Date(clock - 1000).toISOString(), session_group: 'telegram:child', run_id: 'fixture-run',
    event_type: 'subagent_start', category: 'agent', metadata: { agent_id: 'fixture-child' } });
  for (const [group, child] of [['origin', 'hook-child'], [null, 'legacy-child']]) seedStore.insertEvent({
    id: 'fixture-origin-' + child, ingest_id: 'fixture-origin-' + child, timestamp: new Date(clock - 10000).toISOString(),
    session_group: group, run_id: 'fixture-run', event_type: 'subagent_start', category: 'agent', metadata: { agent_id: child } });
  seedStore.insertEvent({ id: 'fixture-failed-offline', ingest_id: 'fixture-failed-offline', timestamp: new Date(clock - 1000).toISOString(), session_group: 'telegram:offline-0',
    event_type: 'activate_failed', category: 'session', metadata: { reason: 'fixture launch failure' } });
  for (const [group, value] of [[null, 11], ['telegram:working', 17], ['telegram:child', 23]]) seedStore.insertMetric({ metric_name: 'usage_event', metric_value: value, timestamp: new Date().toISOString(), runtime: 'claude',
    session_group: group, source: 'fixture', dimensions: { total_input: value, output: 3, cache_read_input_tokens: 2, cost: value / 100, model: 'fixture-model' } });
  const tokens = {};
  for (const scope of ['read', 'admin']) {
    const key = generateApiKey(); seedStore.insertApiKey({ name: `fixture-${scope}`, keyHash: hashApiKey(key), scope });
    const response = await fetch(`${origin}/api/auth/token`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200); tokens[scope] = (await response.json()).token;
  }
  const login = await fetch(`${origin}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'fixture-password' }), redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session=')).split(';')[0];
  // Independent of the declared field catalogue: catch missed nested ISO clocks
  // and unit errors in every actual HTTP/SSE response in both session modes.
  const isoCounts = { single: 0, multi: 0 };
  const assertIsoYears = (value, location) => {
    if (typeof value === 'string' && /^(?:[+-]\d{6}|\d{4})-\d{2}-\d{2}T/.test(value)) {
      const year = new Date(value).getUTCFullYear();
      assert.ok(year >= 2000 && year <= 2100, `${location}: ISO year outside 2000–2100: ${value}`);
      isoCounts[mode]++;
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) assertIsoYears(child, `${location}.${key}`);
    }
  };
  const request = async (route, { method = 'GET', body, identity = 'read', expected = 200, originHeader = true } = {}) => {
    const headers = identity === 'cookie' ? { Cookie: cookie, ...(originHeader ? { Origin: origin } : {}) }
      : identity === 'none' ? {} : { Authorization: `Bearer ${tokens[identity]}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { value = text; }
    assertIsoYears(value, `${mode} ${method} ${route}`);
    records.push({ mode, method, route, identity, status: response.status, body: value });
    if (response.status >= 400) { assert.equal(value.ok, false); assert.equal(typeof value.error?.code, 'string'); assert.equal(typeof value.error?.message, 'string'); }
    assert.equal(response.status, expected, `${method} ${route}: ${text.slice(0, 300)}`);
    return value;
  };

  await t.test('read authentication and runtime options retain read-key access', async () => {
    await request('/api/instance', { identity: 'none', expected: 401 });
    await request('/api/instance/runtime-options?runtime=claude');
  });
  // Real createServer composition, group catalog, history parser and HTTP auth.
  // Run when history group admission or server wiring changes; unrelated UI may
  // skip. Mode and installation observations are supplied by this fixture;
  // HistoryService, group admission and the index.js callback remain real.
  // Transcript and event DB stay under the outer runner's private paths; the
  // enclosing fixture owns server/DB teardown and this case removes its file.
  await t.test('assembled history routes reject unknown groups and retain offline history', async t => {
    const { ObserverCoordinator } = await import('../skills/dashboard/src/lib/observer-coordinator.js');
    t.mock.method(ObserverCoordinator.prototype, 'historyStatus', async () => ({ state: 'installed', desired: { enabled: true } }));
    writeMode('multi');
    const sessionId = 'offline-history-session';
    const project = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(root));
    const transcript = path.join(project, `${sessionId}.jsonl`);
    assert.ok(project.startsWith(process.env.HOME + path.sep));
    console.log('History composition fixture:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
      transcript, database: path.join(data, 'dashboard.db'), tmux: 'unused; offline files only' }));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date(clock).toISOString(),
      message: { content: [{ type: 'text', text: 'Offline history remains readable' }] } }) + '\n');
    t.after(() => { fs.rmSync(project, { recursive: true, force: true }); writeMode('single'); });
    seedStore.insertEvent({ id: 'fixture-offline-history', ingest_id: 'fixture-offline-history',
      timestamp: new Date(clock).toISOString(), session_id: sessionId, session_group: 'telegram:offline-0',
      runtime: 'claude', event_type: 'session_start', category: 'lifecycle' });
    const rejected = await request('/api/observer/history/sessions?session_group=nosuch%3Agroup',
      { identity: 'cookie', expected: 400 });
    assert.equal(rejected.error.code, 'invalid_session_group');
    const offline = await request('/api/groups/telegram%3Aoffline-0?include=', { identity: 'cookie' });
    assert.equal(offline.state.kind, 'offline');
    const history = await request('/api/observer/history/sessions?session_group=telegram%3Aoffline-0', { identity: 'cookie' });
    assert.equal(history.current, null);
    assert.ok(history.sessions.some(session => session.id === sessionId), 'Catalogued offline history stays visible');
    writeMode('single');
    const single = await request('/api/observer/history/sessions?session_group=telegram%3Aoffline-0',
      { identity: 'cookie', expected: 400 });
    assert.equal(single.error.code, 'invalid_session_group');
  });
  const retired = ['/api/health?probe=ready', '/api/state', '/api/restart-status', '/api/session-mode', '/api/instance-status', '/api/timeline', '/api/system', '/api/summary', '/api/communication',
    '/api/metrics/history/cpu_pct', '/api/metrics/aggregate', '/api/metrics/cpu_pct', '/api/metrics/series', '/api/actions/meta', '/api/actions/interrupt', '/api/actions/chop-chop',
    '/api/workbench/groups', '/api/workbench/groups/search', '/api/workbench/activity', '/api/workbench/groups/telegram%3Aworking/raw', '/api/workbench/groups/telegram%3Aworking/config',
    '/api/workbench/usage', '/api/workbench/host', '/api/workbench/pricing', '/api/workbench/name-prompt', '/api/workbench/runtime-overrides', '/api/agent/name', '/api/settings', '/api/settings?all=1', '/api/workbench/schedule', '/api/workbench/schedule/preview', '/api/workbench/schedule/once', '/api/workbench/schedule/once/history', '/api/workbench/memory/backlog', '/api/chat/settings'];
  await t.test('retired reads and actions return 404', async () => {
    for (const route of retired) await request(route, { identity: 'cookie', expected: 404 });
    for (const route of ['/api/actions/interrupt', '/api/actions/chop-chop', '/api/workbench/schedule', '/api/workbench/schedule/once/pause', '/api/workbench/schedule/once/resume', '/api/chat/settings', '/api/settings']) for (const identity of ['cookie', 'read']) await request(route, { method: 'POST', body: {}, identity, expected: 404 });
  });
  const writes = [
    ['/api/settings/pricing', 'PUT', { runtimes: { claude: { fastModeMultiplier: 2.5 } } }],
    ['/api/settings/chat', 'PUT', { chat_allow_remote: true }],
    ['/api/settings/timezone', 'PUT', { tz: 'Asia/Singapore' }],
    ['/api/settings/timezone/actions/restart-services', 'POST', {}],
    ['/api/schedules', 'POST', { prompt: 'Fixture', schedule: { kind: 'every', value: '1h' } }],
    ['/api/schedules/once', 'PUT', { name: 'Fixture' }],
    ['/api/schedules/once', 'DELETE'],
    ...['pause', 'resume'].map(action => [`/api/schedules/once/actions/${action}`, 'POST', {}]),
    ['/api/instance/defaults', 'PUT', { kind: 'model', model: 'fixture-model' }], ['/api/instance/name', 'PUT', { name: 'fixture-agent' }],
    ...['switch-mode', 'switch-runtime', 'upgrade', 'upgrade-runtime'].map(action => [`/api/instance/actions/${action}`, 'POST', {}]),
    ['/api/groups/telegram%3Aworking/config', 'PUT', { kind: 'runtime', value: 'claude' }],
    ['/api/groups/telegram%3Aworking/name', 'PUT', { name: 'Fixture group' }], ['/api/groups/telegram%3Aworking/name', 'DELETE'],
    ...['interrupt', 'chop-chop', 'restart'].map(action => [`/api/groups/telegram%3Aworking/actions/${action}`, 'POST', { runId: 'fixture-run' }]),
    ['/api/groups/telegram%3Aworking', 'DELETE', { confirmed: true, operationId: 'fixture-operation', cutoffId: 1 }],
    ['/api/groups/naming-prompt', 'POST'],
  ];
  await t.test('every object API write requires admin and every browser write requires same origin', async () => {
    const initial = actionCalls.length;
    const allWrites = [...writes,
      ['/api/keys', 'POST', {}], ['/api/keys/reader/rotate', 'POST', {}], ['/api/keys/reader', 'DELETE'], ['/api/keys/purge-revoked', 'POST', {}],
      ['/api/fleet/agents', 'POST', {}], ['/api/fleet/agents/test', 'POST', {}], ['/api/fleet/agents/remote-fixture', 'DELETE'],
      ['/api/chat/drafts', 'POST', {}], ['/api/chat/conversations/origin', 'PATCH', {}], ['/api/chat/conversations/origin/send', 'POST', {}],
      ['/api/chat/conversations/origin/answers', 'POST', {}], ['/api/chat/conversations/origin/uploads', 'POST', {}], ['/api/chat/drafts/fixture', 'DELETE', {}],
      ...['install', 'enable', 'disable', 'agent-size', 'leases', 'leases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/renew', 'leases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/release']
        .map(action => [`/api/observer/${action}`, 'POST', {}]), ['/api/observer/install', 'DELETE'],
    ];
    for (const [route, method, body] of allWrites) {
      await request(route, { method, body, identity: 'none', expected: 401 });
      await request(route, { method, body, expected: 403 });
      await request(route, { method, body, identity: 'cookie', originHeader: false, expected: 403 });
    }
    assert.equal(actionCalls.length, initial, 'denied writes never reach action adapters');
  });
  for (const next of ['single', 'multi']) await t.test(`${next} mode calls each object endpoint over HTTP`, async () => {
    writeMode(next);
    for (const route of ['/api/memory/tree', '/api/memory/backlog', '/api/schedules', '/api/schedules/once', '/api/schedules/once/history', '/api/schedules/preview?kind=every&value=1h', '/api/settings/pricing', '/api/settings/timezone', '/api/settings/chat']) await request(route);
    const file = await request('/api/memory/file?path=example.md', { identity: 'cookie' });
    assert.equal(file.text, '# Fixture memory\n');
    await request('/api/memory/git?path=example.md', { identity: 'cookie' });
    for (const identity of ['none', 'read']) await request('/api/memory/file?path=example.md', { method: 'PUT', body: { text: 'denied', sha256: file.sha256 }, identity, expected: identity === 'none' ? 401 : 403 });
    await request('/api/memory/file?path=example.md', { method: 'PUT', body: { text: file.text, sha256: file.sha256 }, identity: 'cookie', originHeader: false, expected: 403 });
    await request('/api/memory/file?path=example.md', { method: 'PUT', body: { text: file.text, sha256: file.sha256 }, identity: 'cookie' });
    const key = 'origin', encoded = encodeURIComponent(key);
    for (const route of ['/api/health', '/api/health/ready']) await request(route, { identity: 'none' });
    const instance = await request('/api/instance'); assert.equal(instance.session_mode.sessionMode, next); assert.equal(instance.resources.scope, 'container');
    assert.equal(Object.hasOwn(instance, 'system'), false); assert.equal(Object.hasOwn(instance, 'runtime_info'), false);
    assert.equal(Object.hasOwn(instance, 'poolCapacityRecord'), false);
    assert.equal(instance.resources.cpu_source, 'container'); assert.equal(instance.resources.mem_source, 'container');
    assert.equal(instance.versions.claude.installed, '1.0.0');
    assert.equal(instance.resources.sampledAt, new Date(clock).toISOString());
    assert.equal(instance.session_mode.transition.createdAt, new Date((Math.floor(clock / 1000) - 1) * 1000).toISOString());
    assert.equal(instance.session_mode.transition.updatedAt, new Date(Math.floor(clock / 1000) * 1000).toISOString());
    assert.equal(Object.hasOwn(instance, 'chat_allow_remote'), false);
    assert.equal(instance.session_mode.transition.phase, 'draining'); assert.equal(instance.session_mode.blocked.reason, 'fixture-block');
    assert.equal(instance.session_mode.blocked.since, new Date(clock - 1000).toISOString()); assert.equal(instance.session_mode.supervisor, 'unreachable');
    assert.equal(Object.hasOwn(instance, 'context_pct'), false); assert.equal(Object.hasOwn(instance, 'cost'), false);
    await request('/api/instance/resources?range=6h');
    const options = await request('/api/instance/runtime-options?runtime=claude');
    for (const field of ['running_model', 'running_effort']) assert.equal(Object.hasOwn(options, field), false);
    const counts = await request('/api/groups/counts'), running = await request('/api/groups/running');
    assert.equal(running.rows.some(row => row.state.kind === 'offline'), false);
    assert.equal(JSON.stringify(counts).includes('offline-'), false);
    assert.equal(Object.hasOwn(counts, 'mode'), false);
    const runningKeys = ['id', 'displayName', 'channel', 'runtime', 'model', 'state', 'duration', 'flags', 'mainAgent', 'contextPct', 'lastActivityAt', 'currentAction'].sort();
    for (const row of running.rows) assert.deepEqual(Object.keys(row).sort(), runningKeys);
    if (next === 'single') {
      const originRow = running.rows.find(row => row.id === 'origin');
      assert.equal(originRow.state.kind, 'working'); assert.equal(originRow.mainAgent, 'idle');
      assert.equal(originRow.flags.queued.count, 3, 'single Origin owns pending input from every channel');
      assert.equal(originRow.flags.queued.oldestAt, new Date(clock - 1000).toISOString());
      assert.equal(counts.running.flags.queued, 1, 'queued counts rows, not messages');
      assert.equal(originRow.currentAction.message, 'Latest channel message');
      assert.equal(originRow.currentAction.receivedAt, new Date(clock - 100).toISOString());
      const detail = await request('/api/groups/origin?include=');
      assert.deepEqual(detail.currentAction, originRow.currentAction, 'HTTP detail and list share compact action projection');
      assert.equal(detail.queue.pending.count, originRow.flags.queued.count);
      assert.equal(detail.preview.text, originRow.currentAction.message);
      const expanded = await request('/api/groups/origin?include=raw');
      assert.deepEqual(expanded.preview.source, { kind: 'channel' });
      assert.equal(expanded.raw, '[Telegram fixture] Latest channel message', 'raw follows the selected channel preview');
      assert.equal(Object.hasOwn(expanded, 'groupEvidence'), false, 'snapshot source mapping stays private');
      assert.ok(cliCalls.some(args => args[0] === 'groups' && args.includes('--raw') && args[2] === 'telegram:working'));
      assert.equal(detail.working.main, null, 'only child agents work while the main status remains idle');
      assert.equal(detail.working.subagents.count, 2, 'current hook origin and historical null records both contribute');
      assert.ok(detail.duration > 0);
      const timeline = await request('/api/groups/origin/events?run_id=fixture-run');
      assert.equal(timeline.events.filter(event => event.event_type === 'subagent_start').length, 2);
      assert.ok(timeline.events.every(event => event.session_group === null || event.session_group === 'origin'));
      const first = await request('/api/groups/origin/events?run_id=fixture-run&limit=1');
      const second = await request('/api/groups/origin/events?run_id=fixture-run&limit=1&offset=1');
      assert.equal(first.events.length, 1); assert.equal(second.events.length, 1); assert.notEqual(first.events[0].event_seq, second.events[0].event_seq);
    }
    if (next === 'multi') {
      assert.equal(counts.offline.total, 57);
      const child = running.rows.find(row => row.id === 'telegram:child'); assert.equal(child.state.kind, 'working'); assert.equal(child.mainAgent, 'idle');
      const work = running.rows.find(row => row.id === 'telegram:working'); assert.equal(work.state.kind, 'working'); assert.equal(work.flags.queued.count, 3); assert.equal(work.flags.blocked.reason, 'rate_limited'); assert.equal(work.flags.blocked.recoveryAt, new Date(clock + 60000).toISOString());
      const offline = await request('/api/groups/offline?flag=startFailed&limit=1');
      assert.equal(offline.rows.length, 1); assert.equal(offline.rows[0].id, 'telegram:offline-0');
      assert.deepEqual(Object.keys(offline.rows[0]).sort(), ['id', 'displayName', 'channel', 'lastActivityAt', 'flags'].sort());
      assert.equal(offline.rows[0].flags.startFailed.count, 1);
      assert.equal((await request('/api/groups/offline?flag=startFailed&q=not-found')).rows.length, 0);
      await request('/api/groups/offline?flag=invalid', { expected: 400 });
      const lean = await request('/api/groups/origin?include=');
      assert.equal(Object.hasOwn(lean, 'raw'), false); assert.equal(Object.hasOwn(lean, 'config'), false);
      assert.equal(lean.runtimeInfo.runningVersion, '1.0.0'); assert.equal(lean.runtimeInfo.model, 'fixture-model'); assert.equal(lean.runtimeInfo.effort, 'high');
      await request('/api/groups/origin?include=invalid', { expected: 400 });
    }
    for (const route of ['/api/groups/offline?limit=10', '/api/groups/search?q=telegram', '/api/groups/activity?range=60m', `/api/groups/${encoded}`, `/api/groups/${encoded}/usage`,
      `/api/groups/${encoded}/runs`, `/api/groups/${encoded}/messages`, `/api/groups/${encoded}/events`, `/api/groups/${encoded}/backlog`,
      '/api/groups/runtime-overrides', '/api/usage/summary', '/api/usage/pricing']) await request(route);
    const restart = await request(`/api/groups/${encoded}/restarts/11111111-1111-4111-8111-111111111111`);
    assert.equal(restart.group.ready, true, 'a present ready replacement run is visible to restart callers');
    assert.equal(restart.completion, 'done');
    for (const range of ['24h', '7d', '30d']) await request(`/api/usage/series?range=${range}`);
    await request('/api/groups/telegram%3Aworking/deletion-preview', { identity: 'cookie' });
    for (const [route, method, body] of writes) await request(route, { method, body, identity: 'cookie' });
    // Automatic naming reads the mode this instance is really in: Origin in multi, C4's only session in single.
    const naming = records.filter(item => item.route === '/api/groups/naming-prompt' && item.mode === next).at(-1);
    assert.deepEqual(naming.body, { ok: true, controlId: 7, sessionGroup: next === 'multi' ? 'origin' : null });
    const enqueue = cliCalls.filter(call => call[1]?.endsWith('/c4-control.js')).at(-1);
    assert.equal(enqueue.includes('--group'), next === 'multi');
    if (next === 'multi') assert.equal(enqueue[enqueue.indexOf('--group') + 1], 'origin');
    const summary = await request('/api/usage/summary');
    const groups = await Promise.all(['origin', 'telegram:working', 'telegram:child'].map(group => request(`/api/groups/${encodeURIComponent(group)}/usage`)));
    assert.equal(groups.reduce((sum, group) => sum + group.today.tokens, 0), summary.today.tokens);
    assert.ok(summary.today.tokens > 0);
  });
  await t.test('ordinary stream publishes instance and counts payloads matching GET in both modes', async () => {
    for (const next of ['single', 'multi']) {
    writeMode(next);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${origin}/api/stream`, { headers: { Authorization: `Bearer ${tokens.read}` }, signal: controller.signal });
    const reader = response.body.getReader(); let text = '';
    try {
      while (!text.includes('event: groups\n')) {
        const { value, done } = await reader.read(); if (done) break;
        text += new TextDecoder().decode(value); assert.ok(text.length < 65536);
      }
      const events = text.split('\n\n').filter(chunk => chunk.includes('event:')).map(chunk => {
        const type = chunk.match(/event: ([^\n]+)/)[1]; return { type, data: JSON.parse(chunk.match(/data: ([^\n]+)/)[1]) };
      });
      const instance = events.find(event => event.type === 'instance'), groups = events.find(event => event.type === 'groups');
      assert.ok(instance); assert.ok(groups);
      for (const event of events) assertIsoYears(event.data, `${mode} SSE ${event.type}`);
      const expectedInstance = await request('/api/instance'), expectedGroups = await request('/api/groups/counts');
      assert.equal(JSON.stringify(instance.data), JSON.stringify(expectedInstance)); assert.equal(JSON.stringify(groups.data), JSON.stringify(expectedGroups));
      assert.equal(events.some(event => ['state_change', 'fleet_state', 'system_update', 'health_update'].includes(event.type)), false);
      records.push({ mode, method: 'GET', route: '/api/stream', status: response.status, events });
    } finally { clearTimeout(timeout); await reader.cancel(); controller.abort(); }
    }
  });
  await t.test('real HTTP and SSE clocks have plausible years in both session modes', () => {
    for (const mode of ['single', 'multi']) assert.ok(isoCounts[mode] > 0, `${mode} must expose ISO fields`);
  });
  await t.test('a catalog failure leaves Fleet and the ordinary stream available but keeps list reads explicit', async () => {
    catalogReadable = false; clock += 3000;
    try {
      await request('/api/groups/counts', { expected: 502 });
      await request('/api/groups/offline', { expected: 502 });
      await request('/api/groups/search?q=fixture', { expected: 502 });
      const fleet = await request('/api/fleet');
      assert.ok(fleet.agents.some(agent => agent.name === 'remote-fixture'), 'other Fleet records survive local catalog failure');
      assert.equal(fleet.agents.find(agent => agent.self).group_summary.listKnown, false);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${origin}/api/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      try {
        let data = '';
        while (!data.includes('event: groups')) { const item = await reader.read(); assert.equal(item.done, false); data += new TextDecoder().decode(item.value); }
        const block = data.split('event: groups\ndata: ')[1].split('\n\n')[0];
        assert.equal(JSON.parse(block).listKnown, false);
        assert.ok(data.includes('event: instance'));
      } finally { clearTimeout(timer); await reader.cancel(); controller.abort(); }
    } finally { catalogReadable = true; clock += 3000; }
  });
  await t.test('state-only details avoid configuration and original-message commands', async () => {
    const before = cliCalls.length;
    const value = await request('/api/groups/origin?include=');
    assert.equal(value.id, 'origin'); assert.equal(Object.hasOwn(value, 'raw'), false); assert.equal(Object.hasOwn(value, 'config'), false);
    assert.equal(cliCalls.slice(before).filter(args => args.includes('--raw') || args[0] === 'group').length, 0);
    await request('/api/instance/actions/upgrade', { method: 'POST', identity: 'cookie' });
  });
  await t.test('chat connection overflow is an explicit HTTP error', async () => {
    const mock = t.mock.method(SseHub.prototype, 'canAddChatClient', () => false);
    try { const value = await request('/api/stream?chat=1', { identity: 'cookie', expected: 429 }); assert.equal(value.error.code, 'chat_connection_limit'); }
    finally { mock.mock.restore(); }
  });
  assert.ok(actionCalls.some(call => call.action === 'upgrade-zylos'));
  await t.test('detail restart hints use observed CLI and current configuration without leaking into instance', async () => {
    writeMode('multi');
    const settingsDir = path.join(root, '.claude'); fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ model: 'fixture-model', effortLevel: 'high' }));
    let value = await request('/api/groups/origin?include=');
    assert.equal(value.runtimeInfo.pendingRestart, false);
    usageVersion = '0.9.0'; clock += 3000;
    value = await request('/api/groups/origin?include='); assert.equal(value.runtimeInfo.pendingRestart, true);
    usageVersion = '1.0.0'; usageModel = 'old-model'; clock += 3000;
    value = await request('/api/groups/origin?include='); assert.equal(value.runtimeInfo.pendingRestart, true);
    usageModel = 'fixture-model'; usageEffort = 'low'; clock += 3000;
    value = await request('/api/groups/origin?include='); assert.equal(value.runtimeInfo.pendingRestart, true);
    value = await request('/api/groups/telegram%3Aoffline-0?include='); assert.equal(value.runtimeInfo.pendingRestart, false);
    usageVersion = null; usageModel = null; usageEffort = null; clock += 3000;
    value = await request('/api/groups/origin?include='); assert.equal(value.runtimeInfo.runningVersion, null); assert.equal(value.runtimeInfo.pendingRestart, false);
    const instance = await request('/api/instance'); assert.equal(Object.hasOwn(instance, 'runtime_info'), false);
  });
  await t.test('no-response uses the existing reminder and main-response history and ends with the run', async () => {
    writeMode('multi');
    let seq = 0;
    const insert = (event_type, metadata = {}) => seedStore.insertEvent({ id: 'response-proof-' + (++seq), ingest_id: 'response-proof-' + seq,
      timestamp: new Date(clock - 500).toISOString(), session_group: 'origin', run_id: originRun, event_type, category: 'agent', metadata });
    insert('no_response_nudge'); clock += 3000;
    let running = await request('/api/groups/running'), counts = await request('/api/groups/counts');
    let row = running.rows.find(row => row.id === 'origin');
    assert.ok(row.flags.noResponse.since); assert.equal(counts.running.flags.noResponse, 1);
    const fleet = await request('/api/fleet');
    const summary = fleet.agents.find(agent => agent.self).group_summary;
    assert.equal(summary.noResponse.count, counts.running.flags.noResponse);
    assert.ok(summary.problems.find(row => row.reason === 'no_response').durationSeconds >= 3);
    insert('assistant_message', { agent_id: 'child' }); clock += 3000;
    counts = await request('/api/groups/counts'); assert.equal(counts.running.flags.noResponse, 1, 'a child response is not the main agent responding');
    insert('assistant_message'); clock += 3000;
    counts = await request('/api/groups/counts'); assert.equal(counts.running.flags.noResponse, 0, 'main response clears the reminder');
    insert('no_response_nudge'); clock += 3000;
    assert.equal((await request('/api/groups/counts')).running.flags.noResponse, 1);
    originRun = 'replacement-run'; clock += 3000;
    running = await request('/api/groups/running'); row = running.rows.find(row => row.id === 'origin');
    assert.equal(Object.hasOwn(row.flags, 'noResponse'), false, 'a prior run reminder cannot enter its replacement');
    assert.equal((await request('/api/groups/counts')).running.flags.noResponse, 0);
  });
  await t.test('mode status read failure retains mode but reports transition uncertainty', async () => {
    modeStatusReadable = false; clock += 3000;
    const value = (await request('/api/instance')).session_mode;
    assert.equal(value.sessionMode, 'multi'); assert.equal(value.supervisor, 'unknown'); assert.equal(value.globalGate, null);
    assert.equal(value.error.code, 'FIXTURE_UNREADABLE');
  });
  const evidence = process.env.ZYLOS_API_EVIDENCE;
  if (evidence) {
    const destination = path.resolve(evidence);
    if (destination === root || destination.startsWith(root + path.sep)) throw new Error('Evidence must survive fixture cleanup');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify({ isolation: { runtime: 'not started', tmux: 'not started', adapters: ['Core observations', 'CLI', 'IPC', 'upgrade/restart actions', 'deletion'],
      reads: 'real product HTTP/auth/group projection/usage SQLite', limitations: 'Deterministic adapters prove routing and authorization; no real runtime, upgrade, restart or deletion is performed.' }, records }, null, 2));
    console.log(`HTTP evidence written: ${destination}; ${records.length} requests/streams`);
  }
});
