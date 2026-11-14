import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createGroupSnapshot, workbenchResponse, systemSample } from '../skills/dashboard/src/lib/workbench/group-snapshot.js';
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
  const coreConfig = path.join(root, '.zylos/config.json');
  const writeMode = value => fs.writeFileSync(coreConfig, JSON.stringify(value));
  writeMode({});
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' },
    fleet: { agents: [{ name: 'remote-fixture', base_url: 'http://127.0.0.1:1', read_api_key: 'fixture' }] } }));
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  const realGet = https.get;
  https.get = () => {
    const request = Object.assign(new EventEmitter(), { destroy() {}, end() {} });
    setImmediate(() => request.emit('error', new Error('offline fixture')));
    return request;
  };
  let now = Date.now(), count = 1, statusReads = 0;
  const coreModules = async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi' }) };
    if (name === 'status-view.js') return { collectStatus: async () => {
      statusReads++;
      return { view: 'multi', origin: { presence: 'not_running' }, groupListError: null,
        groups: Array.from({ length: count }, (_, i) => ({ sessionGroup: `fixture-${i}`, presence: 'running',
          runtime: 'claude', status: { valid: true, state: i ? 'idle' : 'busy' } })), runtimeHealth: {} };
    } };
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
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  console.log('Fleet refresh isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, tmux: 'not used', network: 'loopback HTTP only; HTTPS blocked; remote polling held' }));
  const { createServer } = await import('../skills/dashboard/src/index.js');
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'fixture-password' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie');
  const readState = async () => {
    const response = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  await t.test('state endpoint reports effective default and preserves invalid or unreadable mode uncertainty', async () => {
    assert.equal((await readState()).session_mode, 'single');
    writeMode({ session_mode: 'invalid' });
    assert.equal((await readState()).session_mode, null);
    fs.writeFileSync(coreConfig, '{ unreadable JSON');
    assert.equal((await readState()).session_mode, null);
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
  await t.test('two later snapshots reach both fleet_state and fleet events using SSE alone', async () => {
    // Begin with one cached group. After this state read, no /api/state or /api/fleet
    // reads occur: only a settings change schedules each existing publication cycle.
    assert.equal((await readState()).group_summary.running, 1);
    abort = new AbortController();
    const stream = await fetch(`${origin}/api/stream`, { headers: { Cookie: cookie }, signal: abort.signal });
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    const source = { name: 'stream-source', base_url: origin, read_api_key: 'fixture' };
    const consumer = new FleetPoller({ fleet: { agents: [source] } });
    let buffered = '';
    const waitForSummary = async expected => {
      const seen = new Set(), deadline = Date.now() + 5000;
      while (seen.size < 2) {
        const end = buffered.indexOf('\n\n');
        if (end >= 0) {
          const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          const event = block.match(/^event: (.*)$/m)?.[1];
          if (!['fleet_state', 'fleet'].includes(event)) continue;
          const value = JSON.parse(block.match(/^data: (.*)$/m)[1]);
          const summary = event === 'fleet_state' ? value.group_summary : value.agents.find(agent => agent.self).group_summary;
          if (summary?.running === expected) {
            if (event === 'fleet_state') {
              consumer._handleSseEvent(source, { event, data: JSON.stringify(value) });
              assert.equal(consumer.getFleet().agents[0].group_summary.running, expected, 'remote SSE ingestion receives the new summary');
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
      now += 3000; // Expire the real Workbench 2 s cache without a timer loop or a slow test.
      const changed = await fetch(`${origin}/api/chat/settings`, { method: 'PUT',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ allowRemote: expected === 2 }) });
      assert.equal(changed.status, 200);
      await waitForSummary(expected);
    }
    assert.equal(statusReads, 3, 'one initial snapshot and one rebuild in each expired SSE cycle');
    abort.abort();
  });
});
