import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import { executeRuntimeSwitch, runtimeCommand, observeRuntimeGroups } from '../../commands/runtime.js';
import { submit, lookupRestartRequest } from '../am-sock-client.js';
import { readConfigStrict } from '../config-store.js';
import { updateConfigWithLock } from '../config-lock.js';

const old = { present: true, runtime: 'claude', launchConfig: { runtime: 'claude', mode: 'default' },
  runId: 'old-run', sessionId: 'changed-after-clear' };

async function fixture(t, { baseline = 'claude', live = old, response = { ok: true, result: 'accepted' }, lookup = 'unknown', disconnected = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-'));
  const file = path.join(dir, 'config.json'), socketPath = path.join(dir, 's');
  fs.writeFileSync(file, JSON.stringify({ runtime: baseline, session_mode: 'single', keep: 1 }));
  const calls = { requests: [], identities: [], lookup: 0, auth: 0, credentials: 0, writes: 0 };
  const f9 = response?.reason === 'manual_restart_pending' ? [{ requestId: 'existing-request', expectedRunId: 'old-run' }] : [];
  let reply = response;
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.slice(0, input.indexOf('\n')));
      calls.requests.push(request);
      if (reply?.result === 'accepted' || (reply === 'lost' && lookup === 'accepted')) f9.push({ ...request });
      if (reply === 'lost') { socket.destroy(); return; }
      socket.end(JSON.stringify({ ...request, ...reply }) + '\n');
    });
  });
  if (!disconnected) await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deps = {
    read: () => readConfigStrict(file), mode: () => ({ mode: 'single' }), exists: () => true,
    adapter: () => ({ checkAuth: async () => { calls.auth++; return { status: 'success' }; } }),
    credentials: () => { calls.credentials++; return true; }, hooksReady: () => ({ ready: true }),
    write: update => { calls.writes++; return updateConfigWithLock({ configFile: file, lockFile: `${file}.lock`, update }); },
    identity: async group => { calls.identities.push(group); if (live instanceof Error) throw live; return live; },
    send: (request, ...options) => {
      assert.deepEqual(options, [], 'use default replyMaxMs and no connect retry');
      assert.deepEqual(Object.keys(request).sort(), ['expectedRunId', 'requestId', 'type', 'version']);
      assert.equal(request.expectedRunId, 'old-run');
      assert.match(request.requestId, /^cli-rt-\d+-[a-zA-Z0-9]+$/);
      return submit(request, { socketPath });
    },
    lookup: async requestId => {
      calls.lookup++;
      return lookupRestartRequest(requestId, { readRequests: () => f9, readCompleted: () => lookup === 'done' });
    },
  };
  return { calls, deps, file, f9, setReply: value => { reply = value; } };
}

async function command(f, json, flags = []) {
  const stdout = [], stderr = [], original = { log: console.log, error: console.error, exit: process.exitCode };
  console.log = line => stdout.push(String(line)); console.error = (...args) => stderr.push(args.join(' ')); process.exitCode = 0;
  try {
    const result = await runtimeCommand(['codex', ...flags, ...(json ? ['--json'] : [])], {
      execute: (target, options) => executeRuntimeSwitch(target, options, f.deps),
    });
    assert.equal(process.exitCode, 0, 'reclaim cannot change successful exit');
    assert.equal(result.ok, true);
    assert.deepEqual(f.calls.identities.at(-1), null);
    assert.equal(result.data.groups.length, 1);
    assert.equal(result.data.groups[0].sessionGroup, 'origin');
    assert.equal(result.data.groups[0].inherits, true);
    if (json) { assert.equal(stdout.length, 1); assert.deepEqual(JSON.parse(stdout[0]), result); }
    else { assert.match(stdout[0], /Baseline saved|Already on/); assert.match(stdout[1], /origin:/); }
    return { data: result.data, stdout, stderr };
  } finally { console.log = original.log; console.error = original.error; process.exitCode = original.exit; }
}

for (const json of [false, true]) {
  const output = json ? 'JSON' : 'text';
  for (const credentials of [false, true]) test(`IF-47 vi single ${output} target already effective credentials=${credentials}`, async t => {
    const f = await fixture(t, { baseline: 'codex', live: { ...old, runtime: 'codex' } });
    const before = fs.readFileSync(f.file, 'utf8');
    const { data } = await command(f, json, credentials ? ['--save-apikey', 'fixture-value'] : []);
    assert.equal(data.groups[0].status, 'effective'); assert.equal(data.reclaim, null);
    assert.equal(f.calls.requests.length, 0); assert.equal(f.calls.credentials, Number(credentials));
    if (!credentials) { assert.equal(f.calls.writes, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), before); }
  });
  test(`IF-47 xv(b) ${output} unchanged retries only on the next invocation`, async t => {
    const f = await fixture(t, { response: { ok: false, result: 'rejected', reason: 'not_ready' } });
    const first = await command(f, json);
    assert.equal(first.data.result, 'saved'); assert.equal(first.data.groups[0].status, 'pending_reclaim');
    assert.equal(first.data.reclaim.result, 'not_submitted'); assert.equal(first.data.reclaim.reason, 'not_ready');
    assert.equal(first.data.warnings[0].code, 'RECLAIM_NOT_SUBMITTED');
    if (!json) assert.match(first.stdout[1], /not_ready; rerun this command later/);
    assert.equal(f.calls.requests.length, 1);
    assert.deepEqual(f.f9, []);
    const before = fs.readFileSync(f.file, 'utf8'); f.setReply({ ok: true, result: 'accepted' });
    const second = await command(f, json);
    assert.equal(second.data.result, 'unchanged'); assert.equal(second.data.reclaim.result, 'accepted');
    assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.calls.writes, 1);
    assert.equal(f.calls.requests.length, 2);
    assert.equal(f.f9.length, 1);
  });
  for (const [label, response, status, result, reason, warning] of [
    ['accepted', { ok: true, result: 'accepted' }, 'pending_reclaim', 'accepted', null, null],
    ['already accepted', { ok: true, result: 'already_accepted' }, 'pending_reclaim', 'already_accepted', null, null],
    ['xv(c) pending', { ok: false, result: 'rejected', reason: 'manual_restart_pending' }, 'pending_reclaim', 'already_pending', 'manual_restart_pending', null],
    ['already stopped', { ok: true, result: 'already_stopped' }, 'not_running', 'already_stopped', null, null],
    ['xv(g) stale', { ok: false, result: 'stale_target', currentRunId: 'new-run' }, 'unknown', 'stale_target', 'new-run', 'RECLAIM_NOT_SUBMITTED'],
    ['public reject', { ok: false, code: 'entry_not_open' }, 'pending_reclaim', 'not_submitted', 'entry_not_open', 'RECLAIM_NOT_SUBMITTED'],
  ]) test(`IF-47 ${output} socket ${label}`, async t => {
    const f = await fixture(t, { response }); const { data } = await command(f, json);
    assert.equal(data.groups[0].status, status); assert.equal(data.reclaim.result, result); assert.equal(data.reclaim.reason, reason);
    assert.deepEqual(data.warnings.map(row => row.code), warning ? [warning] : []);
    assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.lookup, 0);
    if (result === 'already_pending') assert.deepEqual(f.f9, [{ requestId: 'existing-request', expectedRunId: 'old-run' }]);
  });
  for (const [label, live, status] of [
    ['xv(d) absent', { present: false }, 'not_running'], ['xv(e) unrecognized runtime', { ...old, runtime: 'unknown' }, 'unknown'],
    ['xv(e) missing launch config', { ...old, launchConfig: null }, 'unknown'], ['xv(e) missing runId', { ...old, runId: null }, 'unknown'],
    ['xv(e) read error', new Error('tmux read failed'), 'unknown'],
  ]) test(`IF-47 ${output} ${label} never submits`, async t => {
    const f = await fixture(t, { live }); const { data } = await command(f, json);
    assert.equal(data.groups[0].status, status); assert.equal(data.reclaim, null); assert.equal(f.calls.requests.length, 0);
    assert.equal(data.groupsComplete, !(live instanceof Error));
    if (live instanceof Error) assert.equal(data.observationErrors[0].sessionGroup, 'origin');
  });
  test(`IF-47 xv(f) ${output} missing socket retains success`, async t => {
    const f = await fixture(t, { disconnected: true }); const { data } = await command(f, json);
    assert.equal(data.reclaim.result, 'not_submitted'); assert.equal(data.reclaim.reason, 'connect_failed');
    assert.equal(data.warnings[0].code, 'RECLAIM_NOT_SUBMITTED'); assert.equal(f.calls.lookup, 0);
  });
  for (const lookup of ['accepted', 'done', 'unknown']) test(`IF-47 xv(h) ${output} lost socket reply lookup=${lookup}`, async t => {
    const f = await fixture(t, { response: 'lost', lookup }); const { data } = await command(f, json);
    assert.equal(data.reclaim.result, lookup === 'unknown' ? 'unknown' : 'accepted');
    assert.deepEqual(data.warnings.map(row => row.code), lookup === 'unknown' ? ['RECLAIM_RESULT_UNKNOWN'] : []);
    assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.lookup, 1);
  });
}

test('single/null observer reads only the unique session, multi never submits', async () => {
  for (const mode of [null, 'single']) {
    const observed = await observeRuntimeGroups('codex', mode, { identity: async group => {
      assert.equal(group, null); return old;
    }, list: () => { throw new Error('must not list'); }, overrides: () => { throw new Error('must not read overrides'); } });
    assert.equal(observed.groups.length, 1); assert.equal(observed.groups[0].status, 'pending_reclaim');
    const result = await executeRuntimeSwitch('codex', [], { read: () => ({ state: 'ok', config: { runtime: 'codex' } }), mode: () => ({ mode }),
      adapter: () => ({}), identity: async () => ({ ...old, runtime: 'codex' }) });
    assert.equal(result.data.reclaim, null); assert.equal(result.data.groups[0].status, 'effective');
  }
  const result = await executeRuntimeSwitch('codex', [], { read: () => ({ state: 'ok', config: { runtime: 'codex' } }), mode: () => ({ mode: 'multi' }),
    adapter: () => ({}), observe: async () => ({ groups: [], groupsComplete: true, observationErrors: [] }),
    send: () => { throw new Error('multi must not submit'); } });
  assert.equal(result.data.reclaim, null);
});

for (const kind of ['timeout', 'no_reply', 'invalid_reply', 'deadline_exceeded']) {
  for (const found of ['accepted', 'done', 'unknown', 'deadline_exceeded', 'throws']) {
    test(`single uncertain ${kind} lookup ${found} never resubmits`, async t => {
      const f = await fixture(t);
      let sends = 0, lookups = 0;
      f.deps.send = async () => { sends++; return { kind, sent: true }; };
      f.deps.lookup = async () => { lookups++; if (found === 'throws') throw new Error('unreadable F9'); return found; };
      const { data } = await command(f, true);
      assert.equal(sends, 1); assert.equal(lookups, 1);
      assert.equal(data.reclaim.result, ['accepted', 'done'].includes(found) ? 'accepted' : 'unknown');
      assert.deepEqual(data.warnings.map(row => row.code), ['accepted', 'done'].includes(found) ? [] : ['RECLAIM_RESULT_UNKNOWN']);
    });
  }
}
test('single deadline before send is not submitted and does not query F9', async t => {
  const f = await fixture(t);
  f.deps.send = async () => ({ kind: 'deadline_exceeded', sent: false });
  const { data } = await command(f, true);
  assert.equal(data.reclaim.result, 'not_submitted'); assert.equal(data.reclaim.reason, 'deadline_exceeded');
  assert.equal(f.calls.lookup, 0); assert.equal(data.warnings[0].code, 'RECLAIM_NOT_SUBMITTED');
});
