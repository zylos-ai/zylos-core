import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import Database from '../skills/comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { createQueryHandlers } from '../skills/comm-bridge/scripts/c4-v2-cli.js';
import { CoreState } from '../skills/dashboard/src/lib/core-state.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { generateApiKey, hashApiKey, hashPassword } from '../skills/dashboard/src/lib/auth.js';
import { createGroupSnapshot, systemSample } from '../skills/dashboard/src/lib/workbench/group-snapshot.js';
import { loadCoreModule as originalLoadCoreModule } from '../skills/dashboard/src/lib/core-modules.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';

import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import { pathToFileURL } from 'node:url';

// Real Dashboard entry/router, C4 history, event/usage store and mounted frontend.
// Opt-in sandbox + official runner isolate HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR
// and both DBs. Core/runtime/IPC adapters are deterministic; only loopback HTTP
// and a private headless browser run. No live runtime, model, or channel starts.
// Run for group-read validation and overview/conversation/sidebar consumers.
// Skip only when those read contracts and consumers are unchanged, or when
// browser prerequisites are unavailable (report the missing browser gate).
test('catalog-backed Chinese, hyphen and percent groups load real details and timelines at desktop and phone widths',
  { skip: !chatEnabled(), timeout: 180000 }, async t => {
  const sandbox = createChatSandbox(t);
  const root = sandbox.paths.zylos;
  console.log('Legacy browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const data = path.join(root, 'components/dashboard');
  for (const dir of [data, path.join(root, '.zylos'), path.join(root, 'activity-monitor'), path.join(root, 'comm-bridge')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Singapore\n');
  fs.writeFileSync(path.join(root, 'activity-monitor/restart-requests.json'), '[]');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('fixture-password') }, chat: { allowRemote: true } }));
  const configFile = path.join(root, '.zylos/config.json');
  const usageVersion = '1.0.0', usageModel = 'fixture-model', usageEffort = 'high', originRun = 'fixture-run';
  let mode = 'multi', clock = Date.now(), server, seedStore;
  const actionCalls = [], cliCalls = [], records = [];
  t.mock.method(Store.prototype, 'writeGroupDisplayName', (...args) => {
    actionCalls.push({ nameWrite: args });
    assert.fail('historical target reached display-name mutation');
  });
  const savedRoot = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  const writeMode = next => { mode = next; clock += 3000; fs.writeFileSync(configFile, JSON.stringify({ session_mode: mode, runtime: 'claude' })); };
  writeMode('multi');
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  guardDatabase(c4, schema);
  c4.prepare('INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,session_group,status) VALUES(1,?,?,?,?,?,?,?)').run(new Date().toISOString().slice(0, 19).replace('T', ' '), 'in', 'telegram', 'fixture', 'Fixture message', 'tg:历史-项目', 'delivered');
  c4.prepare('INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,session_group,status) VALUES(2,?,?,?,?,?,?,?)').run(new Date().toISOString().slice(0, 19).replace('T', ' '), 'out', 'telegram', 'fixture-hyphen', 'Hyphen legacy message', 'tg:-legacy-group', 'delivered');
  c4.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?)').run('tg:历史-项目', 1);
  c4.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?)').run('tg:-legacy-group', 2);
  c4.prepare('INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,session_group,status) VALUES(3,?,?,?,?,?,?,?)').run(new Date(clock - 7 * 3600000).toISOString().slice(0, 19).replace('T', ' '), 'in', 'telegram', 'fixture-percent', 'Percent legacy message', 'tg:有%号', 'delivered');
  c4.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?)').run('tg:有%号', 3);
  const query = createQueryHandlers(createStore(c4));
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
    c4.close();
    if (savedRoot === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = savedRoot;
    await sandbox.close();
  });
  assert.equal(root, sandbox.paths.zylos);
  console.log('Dashboard object API isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, root, database: path.join(data, 'dashboard.db'), c4: path.join(root, 'comm-bridge/c4.db'),
    tmux: 'none; no subprocess allowed', IPC: 'injected', network: 'loopback HTTP only; HTTPS blocked' }));

  const cli = { runC4Db: async args => {
    cliCalls.push(args);
    const argument = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
    if (args[0] === 'groups') return { ok: true, data: query.groups({
      ...(argument('--active-since') ? { activeSince: Number(argument('--active-since')) } : {}),
      ...(argument('--key-match') ? { keyMatch: argument('--key-match') } : {}),
      ...(argument('--limit') ? { limit: Number(argument('--limit')) } : {}),
      ...(args.includes('--raw') ? { raw: true } : {}),
    }) };
    if (args[0] === 'unsummarized') return { ok: true, data: query.unsummarizedRange({ group: argument('--group') }) };
    return { ok: true, data: query.groupQueues() };
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
  const reader = { readSessionState: async key => ({ identity: { present: key === null || ['origin', 'tg:历史-项目', 'tg:-legacy-group', 'tg:有%号'].includes(key), ready: true,
    runtime: 'claude', runId: key === null || key === 'origin' ? originRun : 'fixture-run', sessionId: 'fixture-session', createdAt: clock / 1000 - 10, launchConfig: { runtime: 'claude', mode: 'default' } },
    status: { valid: true, sampledAt: clock, value: { state: key === 'tg:历史-项目' ? 'busy' : 'idle' } },
    usage: { valid: true, value: { version: usageVersion, effort: { level: usageEffort }, model: { id: usageModel }, context_window: { used_percentage: 25 } } } }),
    readLiveIdentity: async () => ({ present: true, ready: true }), readRuntimeHealth: async () => ({ missing: true }), readAccountUsage: async () => null };
  const core = async name => {
    if (name === 'am-sock-client.js') return { submit: async () => ({ kind: 'rejected', reply: { code: 'invalid_request' } }),
      lookupRestartRequest: async (requestId, options) => {
        assert.ok(['tg:历史-项目', 'tg:-legacy-group', 'tg:有%号'].includes(options.sessionGroup), 'restart lookup retains exact historical group');
        assert.equal(requestId, '11111111-1111-4111-8111-111111111111');
        return 'done';
      } };
    if (name === 'session-mode-status.js') return { readSessionModeStatus: options => { return readSessionModeStatus({ ...options,
      db: { getModeTransition: async () => ({ run_id: 'fixture-transition', source_mode: 'single', target_mode: 'multi', phase: 'draining', reason: 'fixture-block', created_at: clock - 1000, updated_at: clock }),
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
        list: () => [{ sessionGroup: 'tg:历史-项目' }, { sessionGroup: 'tg:-legacy-group' }, { sessionGroup: 'tg:有%号' }],
        facts: () => ({ originNeed: null }), health: () => ({ health: 'rate_limited', cooldownUntil: clock / 1000 + 60 }),
      }) } : name === 'config.js' ? { readSessionMode: () => ({ mode }) }
        : name === 'session-pool-config.js' ? { readPoolCapacity: () => ({ k: 3, valid: true, fresh: true }) } : core(name),
    }),
  } });
  const { createServer } = await import('../skills/dashboard/src/index.js');
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  seedStore = new Store(path.join(data, 'dashboard.db'));
  seedStore.insertEvent({ id: 'fixture-child', ingest_id: 'fixture-child', timestamp: new Date(clock - 1000).toISOString(), session_group: 'tg:-legacy-group', run_id: 'fixture-run',
    event_type: 'subagent_start', category: 'agent', metadata: { agent_id: 'fixture-child' } });
  for (const [group, value] of [[null, 11], ['tg:历史-项目', 17], ['tg:-legacy-group', 23], ['tg:有%号', 29]]) seedStore.insertMetric({ metric_name: 'usage_event', metric_value: value, timestamp: new Date().toISOString(), runtime: 'claude',
    session_group: group, source: 'fixture', dimensions: { total_input: value, output: 3, cache_read_input_tokens: 2, cost: value / 100, model: 'fixture-model' } });
  const tokens = {};
  for (const scope of ['read']) {
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


  seedStore.insertEvent({ id: 'legacy-chinese', ingest_id: 'legacy-chinese', timestamp: new Date(clock - 1000).toISOString(), session_group: 'tg:历史-项目', run_id: 'fixture-run', event_type: 'tool_start', category: 'tool', metadata: { tool: 'Read' } });
  seedStore.insertEvent({ id: 'legacy-percent', ingest_id: 'legacy-percent', timestamp: new Date(clock - 1000).toISOString(), session_group: 'tg:有%号', run_id: 'fixture-run', event_type: 'tool_start', category: 'tool', metadata: { tool: 'Read' } });
  const groups = ['tg:历史-项目', 'tg:-legacy-group', 'tg:有%号'];
  for (const group of groups) {
    const base = '/api/groups/' + encodeURIComponent(group);
    const detail = await request(base);
    assert.equal(detail.id, group);
    const events = await request(base + '/events');
    assert.ok(events.events.length > 0, group + ' retains its event data');
    const runs = await request(base + '/runs');
    assert.ok(runs.runs?.length > 0 || runs.items?.length > 0, JSON.stringify(runs));
    const messages = await request(base + '/messages');
    assert.equal(messages.messages.length, 1, group + ' reads exact C4 history');
    const backlog = await request(base + '/backlog');
    assert.equal(backlog.count, 1);
    assert.ok(backlog.firstAt, 'real C4 backlog retains oldest timestamp');
    assert.equal(backlog.syncing, null, 'historical filesystem lock is not observed');
    assert.equal(backlog.reason, 'backlog_failed');
    const usage = await request(base + '/usage');
    assert.equal(usage.group, group);
    assert.equal(usage.today.inputTokens, group === 'tg:历史-项目' ? 17 : group === 'tg:-legacy-group' ? 23 : 29);
    assert.equal(usage.today.outputTokens, 3);
    const restart = await request(base + '/restarts/11111111-1111-4111-8111-111111111111');
    assert.equal(restart.group.id, group);
    for (const [suffix, method, body] of [['/config', 'PUT', { kind: 'runtime', value: 'claude' }], ['/name', 'PUT', { name: 'fixture' }],
      ['/name', 'DELETE'], ['/actions/restart', 'POST', { runId: 'fixture-run' }], ['', 'DELETE', { confirmed: true, operationId: 'fixture-operation', cutoffId: 1 }], ['/deletion-preview', 'GET']]) {
      const actionsBefore = actionCalls.length, cliBefore = cliCalls.length;
      const denied = await request(base + suffix, { method, body, identity: 'cookie', expected: 400 });
      assert.equal(denied.error.code, suffix === '/name' ? 'KEY_INVALID' : ['', '/deletion-preview'].includes(suffix) ? 'invalid_deletion_target' : 'SESSION_GROUP_INVALID');
      assert.equal(actionCalls.length, actionsBefore, 'invalid target never reaches action or deletion execution');
      assert.equal(cliCalls.length, cliBefore, 'invalid target never reaches config/name CLI');
    }
  }
  const memory = await request('/api/workbench/memory/backlog', { identity: 'cookie' });
  const percentMemory = memory.groups.find(row => row.sessionGroup === 'tg:有%号');
  assert.equal(percentMemory.count, 1); assert.equal(percentMemory.aged, true);
  assert.equal(percentMemory.syncing, null); assert.equal(percentMemory.reason, 'backlog_failed');
  assert.equal(actionCalls.length, 0, 'all historical writes stopped before action execution');
  for (const suffix of ['', '/events', '/runs', '/messages', '/backlog', '/usage', '/restarts/11111111-1111-4111-8111-111111111111']) {
    const answer = await request('/api/groups/' + encodeURIComponent('tg:未登记-历史') + suffix, { expected: 400 });
    assert.equal(answer.error.code, 'SESSION_GROUP_INVALID');
  }
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, env: sandbox.env, headless: true,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await context.setExtraHTTPHeaders({ Cookie: cookie });
    await context.addInitScript(() => { try { localStorage.setItem('zylos-dashboard-locale', 'en'); localStorage.setItem('zylos-dashboard-detail-level', 'technical'); } catch {} });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], failedReads = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/api/groups/tg%3A') && response.status() >= 400) failedReads.push({ url: response.url(), status: response.status() }); });
    await page.goto(origin + '/');
    for (const group of groups) {
      await page.locator('#wb-board .wb-row').filter({ hasText: group }).click();
      await page.locator('#wb-side .wb-now-title').first().waitFor();
      assert.equal(await page.locator('#wb-side').getByText('Group details could not be read', { exact: false }).count(), 0);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (evidence) await page.screenshot({ path: path.join(evidence, `legacy-${width}-${groups.indexOf(group)}-overview.png`) });
      await page.locator('#wb-side .wb-detail-body > .wb-ip-card').last().scrollIntoViewIfNeeded();
      if (evidence) await page.screenshot({ path: path.join(evidence, `legacy-${width}-${groups.indexOf(group)}-usage.png`) });
      await page.locator('#wb-side .wb-detail-tabs button').filter({ hasText: 'Timeline' }).click();
      await page.locator('#wb-side .wb-timeline-run').waitFor();
      if (evidence) await page.screenshot({ path: path.join(evidence, `legacy-${width}-${groups.indexOf(group)}-timeline.png`) });
      await page.keyboard.press('Escape');
      await page.goto(origin + '/');
    }
    assert.deepEqual(errors, [], 'real frontend has no script errors');
    assert.deepEqual(failedReads, [], 'all legacy detail browser reads succeed');
    await context.close();
  }
  writeMode('single');
  for (const group of groups) for (const suffix of ['', '/events', '/runs', '/messages', '/backlog', '/usage', '/restarts/11111111-1111-4111-8111-111111111111']) {
    const hiddenDetail = suffix === '' || suffix.startsWith('/restarts/');
    const answer = await request('/api/groups/' + encodeURIComponent(group) + suffix, { expected: hiddenDetail ? 404 : 200 });
    if (hiddenDetail) assert.equal(answer.error.code, 'GROUP_NOT_FOUND');
  }
  if (evidence) fs.writeFileSync(path.join(evidence, 'legacy-read-observations.json'), JSON.stringify(records, null, 2));
});
