import { CoreLogImporter } from '../skills/dashboard/src/lib/core-log-importer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createGroupSnapshot, systemSample } from '../skills/dashboard/src/lib/workbench/group-snapshot.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { EventLoopMonitor } from '../skills/dashboard/src/lib/event-loop-monitor.js';
import { VersionChecker } from '../skills/dashboard/src/lib/version-checker.js';
import { SystemCollector } from '../skills/dashboard/src/lib/collectors/system-collector.js';
import { FleetPoller } from '../skills/dashboard/src/lib/fleet-poller.js';

// Actual Dashboard HTTP + SSE entry and actual Workbench snapshot/cache, with deterministic
// Core/C4 observations. Run when Fleet publication, mode reporting or snapshot refresh changes;
// unrelated presentation changes can skip. The runner isolates HOME, ZYLOS_DIR, PM2_HOME and
// short TMPDIR. This fixture uses a private installation/database, starts no collectors/tmux,
// blocks release-check HTTPS and replaces remote polling, and closes every stream/server in teardown.
test('Fleet HTTP and SSE keep summaries current without waiting for remote polls', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-refresh-'));
  const data = path.join(root, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.mkdirSync(path.join(root, 'activity-monitor'));
  const requestsFile = path.join(root, 'activity-monitor/restart-requests.json');
  fs.writeFileSync(requestsFile, '[]');
  const coreConfig = path.join(root, '.zylos/config.json');
  const writeMode = value => fs.writeFileSync(coreConfig, JSON.stringify(value));
  writeMode({});
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' },
    fleet: { agents: [{ name: 'remote-fixture', base_url: 'http://127.0.0.1:1', read_api_key: 'fixture' }] } }));
  const previous = process.env.ZYLOS_DIR, previousTmux = process.env.TMUX_TMPDIR;
  process.env.ZYLOS_DIR = root;
  process.env.TMUX_TMPDIR = path.join(root, 'tmux'); fs.mkdirSync(process.env.TMUX_TMPDIR);
  const stores = new Set(), timers = new Set();
  const schemaCheck = Store.prototype.checkSchema, interval = globalThis.setInterval;
  t.mock.method(Store.prototype, 'checkSchema', function (...args) { stores.add(this); return schemaCheck.apply(this, args); });
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = interval(...args); timers.add(timer); return timer; });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  const realGet = https.get;
  https.get = () => {
    const request = Object.assign(new EventEmitter(), { destroy() {}, end() {} });
    setImmediate(() => request.emit('error', new Error('offline fixture')));
    return request;
  };
  let systemCollector;
  t.mock.module('../skills/dashboard/src/lib/collectors/system-collector.js', { namedExports: { SystemCollector: class extends SystemCollector { constructor(...args) { super(...args); systemCollector = this; } } } });
  let importer;
  t.mock.module('../skills/dashboard/src/lib/core-log-importer.js', {namedExports:{CoreLogImporter: class extends CoreLogImporter { constructor(options) {super(options);importer=this;} }}});
  let now = Date.now(), count = 1, statusReads = 0, supervisorPaused = false;
  const coreModules = async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode: (() => { try { return JSON.parse(fs.readFileSync(coreConfig)).session_mode ?? 'single'; } catch { return 'unreadable'; } })() }) };
    if (name === 'status-view.js') return { collectStatus: async () => {
      statusReads++;
      return { view: 'multi', origin: { presence: 'not_running' }, groupListError: null,
        groups: Array.from({ length: count }, (_, i) => ({ sessionGroup: `fixture-${i}`, presence: 'running',
          runtime: 'claude', status: { valid: true, state: i ? 'idle' : 'busy' } })), runtimeHealth: {}, supervisorPaused };
    } };
    if (name === 'session-state-reader.js') return { readAccountUsage: async () => null };
    if (name === 'session-pool-config.js') return { readPoolCapacity: () => ({ k: 12, record: null, valid: true, fresh: true }) };
    throw new Error(`Unexpected Core module ${name}`);
  };
  t.mock.module('../skills/dashboard/src/lib/workbench/group-snapshot.js', { namedExports: {
    systemSample,
    createGroupSnapshot: options => createGroupSnapshot({ ...options, now: () => now, loadCoreModule: coreModules,
      c4Reader: { listSlotOccupancy: () => [] },
      cli: { runC4Db: async () => ({ ok: true, data: { groups: [], hasOlder: false } }),
        readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) } }),
  } });
  let pollCalls = 0, releasePoll;
  const heldPoll = new Promise(resolve => { releasePoll = resolve; });
  t.mock.method(FleetPoller.prototype, 'pollOnce', async function () {
    pollCalls++;
    await heldPoll;
    return this.getFleet();
  });
  let server, abort;
  t.after(async () => {
    releasePoll();
    abort?.abort();
    https.get = realGet;
    for (const timer of timers) clearInterval(timer);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeAttachments?.(); }
    for (const store of stores) if (store.db.open) store.close();
    if (previousTmux === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmux;
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  console.log('Fleet refresh isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, TMUX_TMPDIR: process.env.TMUX_TMPDIR, tmux: 'private namespace; observations injected', network: 'loopback HTTP only; HTTPS blocked; remote polling held' }));
  const { createServer } = await import('../skills/dashboard/src/index.js');
  server = createServer();
  let metricReads = 0;
  for (const store of stores) {
    const prepare = store.db.prepare;
    t.mock.method(store.db, 'prepare', function (sql, ...args) {
      if (/FROM metric_points/i.test(sql)) metricReads++;
      return prepare.call(this, sql, ...args);
    });
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'fixture-password' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie');
  const readInstance = async () => {
    const response = await fetch(`${origin}/api/instance`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await t.test('instance endpoint reports effective default and preserves invalid or unreadable mode uncertainty', async () => {
    const cold = await fetch(`${origin}/api/fleet`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
    assert.equal(cold.status, 200); assert.equal((await cold.json()).agents.find(agent => agent.self).state, 'BUSY', 'cold single Fleet collects its object snapshot before projection');
    assert.equal(statusReads, 1);
    assert.equal((await readInstance()).session_mode.sessionMode, 'single');
    assert.equal(statusReads, 1, 'instance reuses the cold Fleet snapshot');
    writeMode({ session_mode: 'invalid' }); now += 3000;
    assert.equal((await readInstance()).session_mode.sessionMode, null);
    fs.writeFileSync(coreConfig, '{ unreadable JSON'); now += 3000;
    assert.equal((await readInstance()).session_mode.sessionMode, null);
  });
  // API -> real snapshot/cache -> remote Fleet projection in both modes. Run
  // when pause publication or snapshot refresh changes; isolated resources and
  // cleanup are owned by this case's parent, with no real runtime or remote poll.
  await t.test('instance endpoint publishes pause and recovery for single and multi session modes', async () => {
    for (const mode of ['single', 'multi']) {
      writeMode({ session_mode: mode });
      for (const paused of [false, true, false]) {
        supervisorPaused = paused;
        fs.writeFileSync(requestsFile, paused ? '{ broken' : '[]');
        now += 3000;
        const readsBefore = statusReads;
        const value = await readInstance();
        assert.equal(value.supervisorPaused, paused);
        assert.equal(Object.hasOwn(value, 'group_summary'), false, 'group counts have their own API');
        assert.equal(statusReads, readsBefore + 1, 'one fresh snapshot after the instance cache expires');
        const fleetResponse = await fetch(`${origin}/api/fleet`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
        assert.equal(fleetResponse.status, 200);
        const self = (await fleetResponse.json()).agents.find(agent => agent.self);
        assert.equal(self.supervisor_paused, paused);
        assert.equal(statusReads, readsBefore + 1, 'Fleet projection reuses the instance snapshot');
      }
    }
  });
  await t.test('publication without subscribers builds no Workbench snapshot', async () => {
    const before = statusReads;
    now += 30000;
    systemCollector._onUpdate({});
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(statusReads, before, 'actual index publication exits before Core/group reads');
  });
  writeMode({ session_mode: 'multi' });
  await t.test('Fleet response does not await a held remote poll', async () => {
    const request = new AbortController();
    const timer = setTimeout(() => request.abort(), 1000);
    let response;
    try { response = await fetch(`${origin}/api/fleet`, { headers: { Cookie: cookie }, signal: request.signal }); }
    finally { clearTimeout(timer); }
    assert.equal(response.status, 200);
    assert.equal((await response.json()).agents.find(agent => agent.self).group_summary.running, 1);
    assert.equal(pollCalls, 0, 'Fleet reads use the existing remote cache/stream, without request-owned polling');
  });
  releasePoll();
  await t.test('two later snapshots reach group and fleet events and refresh a remote consumer', async () => {
    // Existing collector and settings changes drive publication. The remote consumer follows each group
    // invalidation with the new object reads; they reuse the just-published snapshot.
    await readInstance();
    const counts = await (await fetch(`${origin}/api/groups/counts`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) })).json();
    assert.equal(counts.running.total, 1);
    const initialReads = statusReads;
    abort = new AbortController();
    const stream = await fetch(`${origin}/api/stream`, { headers: { Cookie: cookie }, signal: abort.signal });
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    const source = { name: 'stream-source', base_url: origin, read_api_key: 'fixture' };
    const consumer = new FleetPoller({ fleet: { agents: [source] } }, { fetch: async url => {
      if (url.endsWith('/api/auth/token')) return new Response(JSON.stringify({ token: 'fixture-session' }));
      return fetch(url, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
    } });
    t.after(() => consumer.stop());
    let buffered = '';
    const waitForSummary = async expected => {
      const seen = new Set(), deadline = Date.now() + 5000;
      while (seen.size < 2) {
        const end = buffered.indexOf('\n\n');
        if (end >= 0) {
          const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          const event = block.match(/^event: (.*)$/m)?.[1];
          if (!['groups', 'fleet'].includes(event)) continue;
          const value = JSON.parse(block.match(/^data: (.*)$/m)[1]);
          const running = event === 'groups' ? value.running.total : value.agents.find(agent => agent.self).group_summary?.running;
          if (running === expected) {
            if (event === 'groups') {
              let received;
              const updated = new Promise(resolve => { received = resolve; });
              consumer.onPoll = () => received();
              consumer._handleSseEvent(source, { event, data: JSON.stringify(value) });
              let timer;
              await Promise.race([updated, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Consumer did not refresh object APIs')), 4000); })]).finally(() => clearTimeout(timer));
              assert.equal(consumer.getFleet().agents[0].group_summary.running, expected, 'remote SSE invalidation reads the new summary');
            }
            seen.add(event);
          }
          continue;
        }
        let timer;
        const result = await Promise.race([reader.read(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`SSE-only refresh did not publish ${expected} groups to both event types`)), Math.max(1, deadline - Date.now()));
        })]).finally(() => clearTimeout(timer));
        assert.equal(result.done, false);
        buffered += decoder.decode(result.value, { stream: true });
      }
    };
    for (const expected of [2, 3]) {
      count = expected;
      if (expected === 2) {
        now += 3000;
        const changed = await fetch(`${origin}/api/settings/chat`, { method: 'PUT',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_allow_remote: true }) });
        assert.equal(changed.status, 200);
      } else {
        // Imports no longer build Fleet snapshots. Non-Origin changes are
        // published at the existing system collector cadence, without a page read.
        const beforeImport = statusReads, beforeMetricReads = metricReads;
        for (let i = 0; i < 10; i++) importer.onImport({ types: ['subagent_start'], stream: 'hook', inserted: 1 });
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.equal(statusReads, beforeImport, 'unchanged imports do not collect groups');
        assert.equal(metricReads, beforeMetricReads, 'unchanged imports do not repeat usage SQL or remote invalidation reads');
        now += 30000;
        systemCollector._onUpdate({});
      }
      await waitForSummary(expected);
    }
    assert.equal(statusReads, initialReads + 2, 'one rebuild at each actual publication trigger, including non-Origin collector cadence');
    abort.abort();
  });
});
