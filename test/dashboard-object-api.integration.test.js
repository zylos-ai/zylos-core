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
import { SseHub } from '../skills/dashboard/src/lib/sse.js';

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
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('fixture-password') }, fleet: { agents: [] }, chat: { allowRemote: true } }));
  const configFile = path.join(root, '.zylos/config.json');
  let mode = 'single', clock = Date.now(), server, seedStore;
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
      lastActivityAt: clock - (sessionGroup.includes('offline') ? 9 * 86400000 : 1000), preview: { text: 'Fixture message', message: 'Fixture message', messageRaw: 'Fixture first message' } }));
  const cli = { runC4Db: async args => {
    cliCalls.push(args);
    return { ok: true, data: args[0] === 'groups' ? args.includes('--raw') ? catalog().filter(row => row.sessionGroup === args[2]) : args.includes('--active-since') ? { groups: catalog(), hasOlder: false } : catalog()
      : args[0] === 'unsummarized' ? { count: 0, firstAt: null } : { groups: [{ sessionGroup: 'telegram:working', pending: { count: 3, oldestAt: clock - 1000, head: { id: 1, priority: 0 } }, running: { count: 0 } }], globalFence: null } };
  }, readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) };
  const fakeExecute = (file, args, options, callback) => {
    if (typeof options === 'function') callback = options;
    cliCalls.push([String(file), ...args]);
    let data;
    if (file === 'zylos' && args[0] === 'group' && args[1] === 'overrides') data = { baseline: { runtime: 'claude' }, runtime: [], model: [], runtimeTotal: 0, nextAfter: null };
    else if (file === 'zylos' && args[0] === 'group') data = { resolved: args[1] === 'runtime' ? { runtime: 'claude' } : { runtime: 'claude', mode: 'default' } };
    else if (file === process.execPath && args[0]?.endsWith('/sync-lock.js')) { callback(null, JSON.stringify({ sync: { held: false } }), ''); return new EventEmitter(); }
    else throw new Error(`Unexpected child process in HTTP fixture: ${file} ${args[0]}`);
    callback(null, JSON.stringify({ ok: true, data }), ''); return new EventEmitter();
  };
  fakeExecute[Symbol.for('nodejs.util.promisify.custom')] = (file, args, options) => new Promise((resolve, reject) => {
    fakeExecute(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  t.mock.module('node:child_process', { namedExports: { ...childProcess, execFile: fakeExecute,
    execFileSync: () => { throw new Error('Synchronous child processes are forbidden in HTTP fixture'); } } });
  t.mock.module('../skills/dashboard/src/lib/installed-versions.js', { namedExports: { createInstalledVersionReader: () => async () => ({ zylos: 'fixture', claude: 'fixture', codex: 'fixture' }) } });
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
    runtime: 'claude', runId: 'fixture-run', sessionId: 'fixture-session', createdAt: clock / 1000 - 10, launchConfig: { runtime: 'claude', mode: 'default' } },
    status: { valid: true, sampledAt: clock, value: { state: key === 'telegram:working' ? 'busy' : 'idle' } },
    usage: { valid: true, value: { model: { id: 'fixture-model' }, context_window: { used_percentage: 25 } } } }),
    readLiveIdentity: async () => ({ present: true, ready: true }), readRuntimeHealth: async () => ({ missing: true }), readAccountUsage: async () => null };
  const core = async name => {
    if (name === 'am-sock-client.js') return { submit: async () => ({ kind: 'rejected', reply: { code: 'invalid_request' } }),
      lookupRestartRequest: async (requestId, options) => {
        assert.equal(options.sessionGroup, 'origin', 'the request lookup is bound to the group named in the HTTP path');
        assert.equal(requestId, '11111111-1111-4111-8111-111111111111');
        return 'done';
      } };
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
  t.mock.method(SystemCollector.prototype, 'getLatestSystemData', () => ({ collectedAt: clock, resource_scope: 'container', cpu_pct: 20, cpu_count: 2, mem_pct: 25, mem_used_bytes: 256, mem_total_bytes: 1024, disk_used_pct: 40, disk_free_bytes: 2048 }));
  const { collectStatus } = await import('../cli/lib/status-view.js');
  t.mock.module('../skills/dashboard/src/lib/workbench/group-snapshot.js', { namedExports: { systemSample,
    createGroupSnapshot: options => createGroupSnapshot({ ...options, now: () => clock, cli,
      loadCoreModule: async name => name === 'status-view.js' ? { collectStatus: options => collectStatus({ ...options,
        mode: () => ({ mode }), resolveRoot: () => root, configIssue: () => null, requests: () => [], now: () => clock,
        list: () => [{ sessionGroup: 'telegram:working' }, { sessionGroup: 'telegram:child' }],
        facts: () => ({ originNeed: null }), health: () => ({ health: 'rate_limited', cooldownUntil: clock + 60000 }),
      }) } : name === 'config.js' ? { readSessionMode: () => ({ mode }) }
        : name === 'session-pool-config.js' ? { readPoolCapacity: () => ({ k: 3, valid: true, fresh: true }) } : core(name),
    }),
  } });
  const { createServer } = await import('../skills/dashboard/src/index.js');
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  seedStore = new Store(path.join(data, 'dashboard.db'));
  seedStore.insertEvent({ id: 'fixture-child', ingest_id: 'fixture-child', timestamp: new Date(clock - 1000).toISOString(), session_group: 'telegram:child', run_id: 'fixture-run',
    event_type: 'subagent_start', category: 'agent', metadata: { agent_id: 'fixture-child' } });
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
  const request = async (route, { method = 'GET', body, identity = 'read', expected = 200, originHeader = true } = {}) => {
    const headers = identity === 'cookie' ? { Cookie: cookie, ...(originHeader ? { Origin: origin } : {}) }
      : identity === 'none' ? {} : { Authorization: `Bearer ${tokens[identity]}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { value = text; }
    records.push({ mode, method, route, identity, status: response.status, body: value });
    assert.equal(response.status, expected, `${method} ${route}: ${text.slice(0, 300)}`);
    return value;
  };

  await t.test('read authentication and runtime options retain read-key access', async () => {
    await request('/api/instance', { identity: 'none', expected: 401 });
    await request('/api/instance/runtime-options?runtime=claude');
  });
  const retired = ['/api/health?probe=ready', '/api/state', '/api/agent-status', '/api/restart-status', '/api/session-mode', '/api/instance-status', '/api/timeline', '/api/system', '/api/summary', '/api/communication',
    '/api/metrics/history/cpu_pct', '/api/metrics/aggregate', '/api/metrics/cpu_pct', '/api/metrics/series', '/api/actions/meta', '/api/actions/interrupt', '/api/actions/chop-chop',
    '/api/workbench/groups', '/api/workbench/groups/search', '/api/workbench/activity', '/api/workbench/groups/telegram%3Aworking/raw', '/api/workbench/groups/telegram%3Aworking/config',
    '/api/workbench/usage', '/api/workbench/host', '/api/workbench/pricing', '/api/workbench/name-prompt', '/api/workbench/runtime-overrides', '/api/agent/name', '/api/settings'];
  await t.test('retired reads and actions return 404', async () => {
    for (const route of retired) await request(route, { identity: 'cookie', expected: 404 });
    for (const route of ['/api/actions/interrupt', '/api/actions/chop-chop']) await request(route, { method: 'POST', body: {}, identity: 'cookie', expected: 404 });
  });
  const writes = [
    ['/api/instance/defaults', 'PUT', { kind: 'model', model: 'fixture-model' }], ['/api/instance/name', 'PUT', { name: 'fixture-agent' }],
    ...['switch-mode', 'switch-runtime', 'upgrade', 'upgrade-runtime'].map(action => [`/api/instance/actions/${action}`, 'POST', {}]),
    ['/api/groups/telegram%3Aworking/config', 'PUT', { kind: 'runtime', value: 'claude' }],
    ['/api/groups/telegram%3Aworking/name', 'PUT', { name: 'Fixture group' }], ['/api/groups/telegram%3Aworking/name', 'DELETE'],
    ...['interrupt', 'chop-chop', 'restart'].map(action => [`/api/groups/telegram%3Aworking/actions/${action}`, 'POST', { runId: 'fixture-run' }]),
    ['/api/groups/telegram%3Aworking', 'DELETE', { confirmed: true, operationId: 'fixture-operation', cutoffId: 1 }],
  ];
  await t.test('every first-step write requires admin and every browser write requires same origin', async () => {
    const initial = actionCalls.length;
    for (const [route, method, body] of writes) {
      await request(route, { method, body, expected: 403 });
      await request(route, { method, body, identity: 'cookie', originHeader: false, expected: 403 });
    }
    assert.equal(actionCalls.length, initial, 'denied writes never reach action adapters');
  });
  for (const next of ['single', 'multi']) await t.test(`${next} mode calls each first-step endpoint over HTTP`, async () => {
    writeMode(next);
    const key = 'origin', encoded = encodeURIComponent(key);
    for (const route of ['/api/health', '/api/health/ready']) await request(route, { identity: 'none' });
    const instance = await request('/api/instance'); assert.equal(instance.session_mode, next); assert.equal(instance.resources.scope, 'container');
    assert.equal(Object.hasOwn(instance, 'context_pct'), false); assert.equal(Object.hasOwn(instance, 'cost'), false);
    await request('/api/instance/resources?range=6h'); await request('/api/instance/runtime-options?runtime=claude');
    const counts = await request('/api/groups/counts'), running = await request('/api/groups/running');
    assert.equal(running.rows.some(row => row.state.kind === 'offline'), false);
    assert.equal(JSON.stringify(counts).includes('offline-'), false);
    if (next === 'multi') {
      assert.equal(counts.offline.total, 57);
      const child = running.rows.find(row => row.id === 'telegram:child'); assert.equal(child.state.kind, 'working'); assert.equal(child.mainAgent, 'idle');
      const work = running.rows.find(row => row.id === 'telegram:working'); assert.equal(work.state.kind, 'working'); assert.equal(work.flags.queued.count, 3); assert.equal(work.flags.blocked.reason, 'rate_limited');
    }
    for (const route of ['/api/groups/offline?limit=10', '/api/groups/search?q=telegram', '/api/groups/activity?range=60m', `/api/groups/${encoded}`, `/api/groups/${encoded}/usage`,
      `/api/groups/${encoded}/runs`, `/api/groups/${encoded}/messages`, `/api/groups/${encoded}/events`, `/api/groups/${encoded}/backlog`,
      '/api/groups/runtime-overrides', '/api/groups/naming-prompt', '/api/usage/summary', '/api/usage/pricing']) await request(route);
    const restart = await request(`/api/groups/${encoded}/restarts/11111111-1111-4111-8111-111111111111`);
    assert.equal(restart.group.ready, true, 'a present ready replacement run is visible to restart callers');
    assert.equal(restart.completion, 'done');
    for (const range of ['24h', '7d', '30d']) await request(`/api/usage/series?range=${range}`);
    await request('/api/groups/telegram%3Aworking/deletion-preview', { identity: 'cookie' });
    for (const [route, method, body] of writes) await request(route, { method, body, identity: 'cookie' });
    const summary = await request('/api/usage/summary');
    const groups = await Promise.all(['origin', 'telegram:working', 'telegram:child'].map(group => request(`/api/groups/${encodeURIComponent(group)}/usage`)));
    assert.equal(groups.reduce((sum, group) => sum + group.today.tokens, 0), summary.today.tokens);
    assert.ok(summary.today.tokens > 0);
  });
  await t.test('ordinary stream publishes instance and counts payloads matching GET', async () => {
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
      const expectedInstance = await request('/api/instance'), expectedGroups = await request('/api/groups/counts');
      assert.equal(JSON.stringify(instance.data), JSON.stringify(expectedInstance)); assert.equal(JSON.stringify(groups.data), JSON.stringify(expectedGroups));
      assert.equal(events.some(event => ['state_change', 'fleet_state', 'system_update', 'health_update'].includes(event.type)), false);
      records.push({ mode, method: 'GET', route: '/api/stream', status: response.status, events });
    } finally { clearTimeout(timeout); await reader.cancel(); controller.abort(); }
  });
  await t.test('chat connection overflow is an explicit HTTP error', async () => {
    const mock = t.mock.method(SseHub.prototype, 'canAddChatClient', () => false);
    try { const value = await request('/api/stream?chat=1', { identity: 'cookie', expected: 429 }); assert.equal(value.error, 'chat_connection_limit'); }
    finally { mock.mock.restore(); }
  });
  assert.ok(actionCalls.some(call => call.action === 'upgrade-zylos'));
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
