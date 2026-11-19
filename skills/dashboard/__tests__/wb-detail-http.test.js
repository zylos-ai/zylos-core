import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as childProcess from 'node:child_process';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { StateEngine } from '../src/lib/state-engine.js';
import { AuthGate, hashApiKey } from '../src/lib/auth.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';

// HTTP integration: actual createServer, AuthGate, route dispatch, display-name
// service and read-only C4Reader over private SQLite. Run for detail route/auth
// changes; skip rendering-only work. The official runner must isolate HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR and TMUX_TMPDIR before loading this file.
// All child_process/Core inputs are injected; no real CLI, PM2 or tmux/socket is
// used. The loopback server and each request are bounded; teardown closes every
// server/database/auth timer and removes only the owned temporary directory.
test('group detail HTTP dispatch enforces local scopes and preserves group boundaries', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-detail-http-'));
  const dashboardDir = path.join(root, 'components/dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  c4.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT, direction TEXT, channel TEXT, timestamp TEXT, content TEXT)');
  const put = c4.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)');
  put.run(1, null, 'in', 'telegram', '2026-10-01 12:00:00', 'private single body');
  put.run(2, 'origin', 'out', 'telegram', '2026-10-01 12:00:00', 'private Origin body');
  put.run(3, null, 'out', 'internal', '2026-10-01 12:00:00', 'private internal body');
  put.run(4, 'telegram:a', 'in', 'telegram', '2026-10-01 12:00:00', 'private ordinary body');
  let clock = 1800000000000;
  let engine, auth, reader, server, view = 'multi', snapshotReads = 0, cachedSnapshot = null;
  const calls = [], restarts = [];
  let controlFailure = null;
  const previous = process.env.ZYLOS_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    clearInterval(auth?._cleanupTimer);
    reader?.close();
    c4.close();
    engine?.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  // Version discovery is a startup dependency, outside the action transport
  // boundary whose exact child count and authorization this fixture proves.
  t.mock.module('../src/lib/installed-versions.js', { namedExports: {
    createInstalledVersionReader: () => async () => ({ zylos: '1.0.0', claude: '1.0.0', codex: '1.0.0' }),
  } });
  const groups = [
    { sessionGroup: 'telegram:recent', componentName: 'telegram', lastActivityAt: clock - 2 * 86400000 },
    { sessionGroup: 'telegram:old', componentName: 'telegram', lastActivityAt: clock - 5 * 86400000 },
    { sessionGroup: 'telegram:named', componentName: 'telegram', lastActivityAt: clock - 86400000 },
    { sessionGroup: 'origin', lastActivityAt: clock - 86400000 },
  ];
  const execute = (file, args) => {
    calls.push({ file, args });
    if (file === 'zylos' && args[0] === 'group') {
      return { stdout: JSON.stringify({ ok: true, data: { resolved: { runtime: 'claude' }, marker: 'configuration-handler' } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/comm-bridge/scripts/c4-control.js')) {
      if (controlFailure) throw controlFailure;
      return { stdout: JSON.stringify({ ok: true, data: { id: 41 } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/comm-bridge/scripts/c4-db.js') && args[1] === 'groups') {
      const cutoff = Number(args[args.indexOf('--active-since') + 1]);
      return { stdout: JSON.stringify({ ok: true, data: { groups: groups.filter(row => row.lastActivityAt >= cutoff), hasOlder: false } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/comm-bridge/scripts/c4-db.js') && args[1] === 'unsummarized') {
      const global = !args.includes('--group');
      return { stdout: JSON.stringify({ ok: true, data: { count: global ? 3 : 7, firstAt: 100 } }) };
    }
    if (args[0] === path.join(root, '.claude/skills/zylos-memory/scripts/sync-lock.js')) {
      return { stdout: JSON.stringify({ sync: { held: true }, origin: { held: false } }) };
    }
    assert.fail(`Unexpected child request: ${file} ${args.join(' ')}`);
  };
  const execFile = () => assert.fail('callback child invocation must not bypass the injected transport');
  execFile[promisify.custom] = async (...args) => execute(...args);
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess, execFile,
    execFileSync: (file, args) => { assert.deepEqual(args, ['--version']); return '1.0.0'; },
    spawn: () => assert.fail('HTTP fixture must not spawn a process'),
  } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  t.mock.module('../src/lib/auth.js', { namedExports: {
    ...await import('../src/lib/auth.js'),
    AuthGate: class extends AuthGate { constructor(...args) { super(...args); auth = this; } },
  } });
  t.mock.module('../src/lib/c4-reader.js', { namedExports: {
    C4Reader: class extends C4Reader { constructor(...args) { super(...args); reader = this; } },
  } });
  const snapshot = () => ({ view, rows: [{ sessionGroup: view === 'single' ? null : 'origin',
    live: { runId: view === 'single' ? 'single-run' : 'origin-run' } }], instance: {} });
  t.mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: {
    createGroupSnapshot: () => ({
      getSnapshot: async () => { snapshotReads++; cachedSnapshot = snapshot(); return cachedSnapshot; },
      getCachedSnapshot: () => cachedSnapshot,
      channelRestartCounter: { update() {} },
    }),
  } });
  t.mock.module('../src/lib/core-modules.js', { namedExports: {
    loadCoreModule: async name => {
      if (name === 'runtime/descriptors.js') return import('../../../cli/lib/runtime/descriptors.js');
      if (['model-rotation-thresholds.js', 'session-usage-reader.js', 'session-hot-ttl.js', 'config-store.js', 'config-lock.js', 'private-file.js', 'pm2.js', 'session-nudge.js'].includes(name)) return import(new URL('../../../cli/lib/' + name, import.meta.url));
      if (name === 'config.js') return { ZYLOS_DIR: root, readSessionMode: () => ({ mode: 'multi' }) };
      if (name === 'am-sock-client.js') return {
        submit: async request => { restarts.push(request); return { kind: 'accepted', reply: { result: 'accepted' } }; },
        lookupRestartRequest: () => assert.fail('accepted restart must not query a second time'),
      };
      assert.fail(`Unexpected Core module: ${name}`);
    },
  } });
  process.env.ZYLOS_DIR = root;
  console.log('Detail HTTP isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: path.join(dashboardDir, 'dashboard.db'), transport: 'loopback; all children injected' }));
  const { createServer } = await import(`../src/index.js?group-detail-http=${clock}`);
  if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  for (const [index, scope] of ['read', 'admin'].entries()) {
    const token = `zylos_st_${String(index + 1).repeat(64)}`;
    const key = engine.store.insertApiKey({ name: `fixture-${scope}`, keyHash: hashApiKey(`zylos_ak_${String(index + 3).repeat(64)}`), scope });
    engine.store.insertApiSession({ apiKeyId: Number(key.lastInsertRowid), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: clock, scope, expiresAt: clock + 60000 });
    tokens[scope] = token;
  }
  const request = (route, scope = 'read', body) => fetch(origin + route, {
    signal: AbortSignal.timeout(3000),
    method: body === undefined ? 'GET' : route.endsWith('/config') ? 'PUT' : 'POST',
    headers: { Authorization: `Bearer ${tokens[scope]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const writes = [
    { route: '/config', body: { kind: 'runtime', value: 'codex' } },
    ...['interrupt', 'chop-chop', 'restart'].map(action => ({ route: `/actions/${action}`, body: { runId: 'fixture-run', sessionId: 'fixture-session' } })),
  ];

  await t.test('local read keys cannot submit configuration or any group action', async () => {
    const before = calls.length;
    for (const { route, body } of writes) {
      const response = await request('/api/groups/telegram%3Aa' + route, 'read', body);
      assert.equal(response.status, 403, route);
      assert.deepEqual(await response.json(), { ok: false, error: { code: 'insufficient_scope', message: 'insufficient_scope' }, required: 'admin' });
    }
    assert.equal(calls.length, before, 'denied writes must never reach a child transport');
    assert.equal(restarts.length, 0);
  });

  await t.test('local admin keys reach each configuration and group action handler', async () => {
    for (const { route, body } of writes) {
      const response = await request('/api/groups/telegram%3Aa' + route, 'admin', body);
      assert.equal(response.status, 200, route);
      const value = await response.json();
      assert.equal(value.ok, true, route);
      if (route === '/config') assert.equal(value.data.marker, 'configuration-handler');
      else if (route === '/actions/restart') assert.equal(value.result, 'accepted');
      else assert.equal(value.controlId, 41);
    }
    assert.equal(calls.filter(call => call.file === 'zylos').length, 1);
    assert.equal(calls.filter(call => call.args[1] === 'enqueue').length, 3);
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0].sessionGroup, 'telegram:a');
    assert.equal(restarts[0].expectedRunId, 'fixture-run');
  });

  await t.test('automatic naming is an admin POST that queues the prompt for Origin and reports refusals', async () => {
    const naming = (scope, init = { method: 'POST' }) => fetch(origin + '/api/groups/naming-prompt', { signal: AbortSignal.timeout(3000),
      ...init, headers: scope ? { Authorization: `Bearer ${tokens[scope]}` } : {} });
    const enqueues = () => calls.filter(call => call.args[1] === 'enqueue');
    const before = enqueues().length;
    const anonymous = await naming(null);
    assert.equal(anonymous.status, 401, 'a request without a login is refused');
    const readOnly = await naming('read');
    assert.equal(readOnly.status, 403);
    assert.deepEqual(await readOnly.json(), { ok: false, error: { code: 'insufficient_scope', message: 'insufficient_scope' }, required: 'admin' });
    const read = await naming('admin', { method: 'GET' });
    assert.equal(read.status, 404, 'the old read of the prompt is gone');
    assert.deepEqual(await read.json(), { ok: false, error: { code: 'not_found', message: 'not_found' } });
    assert.equal((await naming('admin', { method: 'HEAD' })).status, 404);
    assert.equal(enqueues().length, before, 'refused requests never reach C4');

    const script = path.join(root, '.claude/skills/comm-bridge/scripts/c4-control.js');
    const prompt = enqueue => enqueue.args[enqueue.args.indexOf('--content') + 1];
    // The mode comes from this instance's own configuration file.
    const configFile = path.join(root, '.zylos/config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    for (const [mode, target] of [['multi', ['--group', 'origin']], ['single', []]]) {
      fs.writeFileSync(configFile, JSON.stringify({ session_mode: mode }));
      const response = await naming('admin');
      assert.equal(response.status, 200, mode);
      assert.deepEqual(await response.json(), { ok: true, controlId: 41, sessionGroup: mode === 'multi' ? 'origin' : null });
      const call = enqueues().at(-1);
      assert.equal(call.file, process.execPath);
      assert.deepEqual(call.args.filter(arg => arg !== prompt(call)),
        [script, 'enqueue', '--content', '--no-ack-suffix', ...target, '--json'], mode);
      assert.ok(prompt(call).includes(path.join(root, '.claude/skills/dashboard/scripts/group-name.js')), 'the prompt names the installed CLI');
      assert.match(prompt(call), /^请给 Dashboard 里还没有名字的会话组起个名字/);
    }
    assert.equal(enqueues().length, before + 2, 'one control per confirmed request');

    fs.writeFileSync(configFile, JSON.stringify({ session_mode: 'multi' }));
    controlFailure = Object.assign(new Error('Command failed'), { stdout: JSON.stringify({ ok: false,
      error: { code: 'CONTROL_TARGET_REQUIRED', message: 'A control target is required in multi or during transition' } }) });
    const logged = t.mock.method(console, 'error', () => {});
    try {
      const refused = await naming('admin');
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { ok: false, sessionGroup: 'origin',
        error: { code: 'CONTROL_TARGET_REQUIRED', message: 'C4 did not queue the naming prompt' } });

      // The child crashed: the answer is a code and a fixed sentence; the command, prompt, path and stack are only logged.
      const crash = `Command failed: ${process.execPath} ${path.join(root, '.claude/skills/comm-bridge/scripts/c4-control.js')} enqueue --content 请给 Dashboard 里还没有名字的会话组起个名字\n`
        + `Error: Cannot find module '${root}/c4-db.js'\n    at Function._resolveFilename (node:internal/modules/cjs/loader:1225:15)`;
      controlFailure = Object.assign(new Error(crash), { code: 1, stdout: '', stderr: '' });
      const crashed = await naming('admin');
      assert.equal(crashed.status, 502);
      const body = await crashed.text();
      assert.deepEqual(JSON.parse(body), { ok: false, unknown: true, sessionGroup: 'origin',
        error: { code: 'RESULT_UNKNOWN', message: 'Send command failed (exit 1)' } });
      for (const fragment of ['Command failed', 'c4-control', '请给', root, 'node:internal', ' at ']) assert.equal(body.includes(fragment), false, `no ${fragment} in the response`);
      assert.ok(logged.mock.calls.some(call => String(call.arguments[0]).includes(crash)), 'the service log keeps the original');
    } finally { controlFailure = null; logged.mock.restore(); fs.rmSync(configFile); }
  });

  await t.test('single message HTTP reads NULL attribution without exposing bodies or Origin rows', async () => {
    view = 'single'; cachedSnapshot = snapshot();
    const range = '?since=2026-10-01T00%3A00%3A00Z&until=2026-10-02T00%3A00%3A00Z';
    const response = await request('/api/groups/origin/messages' + range);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.messages.map(row => row.id), [1]);
    assert.deepEqual(Object.keys(value.messages[0]), ['id', 'direction', 'channel', 'timestamp']);
    assert.doesNotMatch(JSON.stringify(value), /private|content/);
    assert.equal(snapshotReads, 0, 'message reads reuse the cached single view without rebuilding');
    view = 'multi'; cachedSnapshot = snapshot();
    const originResponse = await request('/api/groups/origin/messages' + range);
    assert.deepEqual((await originResponse.json()).messages.map(row => row.id), [2]);
  });

  await t.test('run HTTP reads use the cached view and never rebuild a snapshot', async () => {
    for (const [index, sessionGroup] of [null, 'origin'].entries()) {
      const id = `http-run-event-${index}`;
      assert.equal(engine.store.insertEvent({
        id, ingest_id: id, runtime: 'claude',
        timestamp: '2026-10-01T12:00:00.000Z',
        event_type: 'session_start', category: 'lifecycle', metadata: {},
        session_group: sessionGroup, run_id: index === 0 ? 'single-run' : 'origin-run',
      }).inserted, true);
    }
    const before = snapshotReads, childBefore = calls.length;
    for (const [mode, expectedRun] of [['single', 'single-run'], ['multi', 'origin-run']]) {
      view = mode; cachedSnapshot = snapshot();
      const response = await request('/api/groups/origin/runs?limit=3');
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.deepEqual(value.runs.map(run => [run.runId, run.endReason]), [[expectedRun, 'running']]);
      assert.equal(value.totalRuns, 1);
      assert.equal(value.totalEvents, 1);
      assert.equal(value.unattributed, 0);
      assert.equal(snapshotReads, before, 'run reads must not invoke the rebuilding snapshot getter');
      const counted = await (await request('/api/groups/origin/runs?limit=3&types=stop,idle')).json();
      assert.deepEqual(counted.runs.map(run => [run.runId, run.n]), [[expectedRun, 0]], 'types narrow the counts, not the runs listed');
      assert.equal(counted.totalRuns, 1);
      assert.equal(counted.totalEvents, 0);
    }
    assert.equal(calls.length, childBefore);
  });

  await t.test('backlog HTTP reads reuse cached views without rebuilding even when count cache is warm', async () => {
    const before = snapshotReads;
    // The fixture's group lock is held and its Origin Sync lock is not: Origin's details read the group lock.
    for (const [mode, count, syncing] of [['single', 3, true], ['multi', 7, true]]) {
      view = mode; cachedSnapshot = snapshot();
      for (let round = 0; round < 2; round++) {
        const response = await request('/api/groups/origin/backlog');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { count, firstAt: new Date(100).toISOString(), syncing });
        assert.equal(snapshotReads, before, 'backlog must not invoke the rebuilding getter with a cached view');
      }
    }
    const countCalls = calls.filter(call => call.args[1] === 'unsummarized');
    assert.deepEqual(countCalls.map(call => call.args.slice(1)), [
      ['unsummarized', '--json'], ['unsummarized', '--group', 'origin', '--json'],
    ]);
    const lockCalls = calls.filter(call => call.args[0].endsWith('/sync-lock.js'));
    assert.deepEqual(lockCalls.map(call => call.args.slice(1)), [
      ['status', '--json'], ['status', '--group', 'origin', '--json'],
    ]);
  });

  await t.test('cold detail scopes build one snapshot and subsequent reads reuse it while unreadable views keep Origin', async () => {
    const range = '?since=2026-10-01T00%3A00%3A00Z&until=2026-10-02T00%3A00%3A00Z';
    const assertSingle = async route => {
      const response = await request('/api/groups/origin/' + route);
      assert.equal(response.status, 200, route);
      const value = await response.json();
      if (route === 'runs') {
        assert.deepEqual(value.runs.map(run => run.runId), ['single-run']);
        assert.equal(value.runs[0].endReason, 'running');
      } else if (route === 'backlog') assert.deepEqual(value, { count: 3, firstAt: new Date(100).toISOString(), syncing: true });
      else assert.deepEqual(value.messages.map(row => row.id), [1]);
    };
    for (const first of ['runs', 'backlog', 'messages' + range]) {
      view = 'single'; cachedSnapshot = null;
      const before = snapshotReads;
      await assertSingle(first);
      assert.equal(snapshotReads, before + 1, first + ' must resolve a cold cache once');
      for (const route of ['runs', 'backlog', 'messages' + range]) await assertSingle(route);
      assert.equal(snapshotReads, before + 1, 'hot detail routes must share the newly populated snapshot');
    }
    // A cached snapshot with no usable view is an observed failure, not a cold
    // cache. Preserve its explicit Origin request rather than guessing single.
    cachedSnapshot = { view: null, rows: [], instance: {} };
    clock += 30001;
    const before = snapshotReads;
    const response = await request('/api/groups/origin/backlog');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 7, firstAt: new Date(100).toISOString(), syncing: true }, 'Origin reads its group sync lock, not the Origin Sync lock');
    assert.deepEqual(calls.at(-2).args.slice(1), ['unsummarized', '--group', 'origin', '--json']);
    assert.deepEqual(calls.at(-1).args.slice(1), ['status', '--group', 'origin', '--json']);
    assert.equal(snapshotReads, before, 'a cached unreadable view must not trigger a new build');
  });

  await t.test('invalid group keys are rejected before any child command or restart submission', async () => {
    const before = calls.length, restartBefore = restarts.length;
    for (const key of ['--json', 'a%2Fb']) {
      const base = '/api/groups/' + key;
      for (const suffix of ['/runs', '/messages', '/backlog', '']) {
        const response = await request(base + suffix, 'admin');
        assert.equal(response.status, 400, key + suffix);
        assert.equal((await response.json()).error.code, 'SESSION_GROUP_INVALID');
      }
      for (const { route, body } of writes) {
        const response = await request(base + route, 'admin', body);
        assert.equal(response.status, 400, key + route);
        assert.equal((await response.json()).error.code, 'SESSION_GROUP_INVALID');
      }
    }
    assert.equal(calls.length, before);
    assert.equal(restarts.length, restartBefore);
  });
});
