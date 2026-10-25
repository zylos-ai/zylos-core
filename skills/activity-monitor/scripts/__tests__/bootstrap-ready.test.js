import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishBootstrapReady } from '../bootstrap-ready.js';
import { readBootstrapIdentity } from '../bootstrap-identity.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { env: { ZYLOS_RUN_ID: 'run' }, scopeReader: async () => ({ dir }), identityReader: async () => ({ runtime: 'codex' }), dir };
}

test('IF-19 local publication follows enqueue and retains the exact control IDs', async t => {
  const f = fixture(t), file = path.join(f.dir, 'current-session.json');
  const result = await publishBootstrapReady({ source: 'startup', session_id: 's' }, { ...f, now: () => 42,
    enqueue: async () => { assert.equal(fs.existsSync(file), false); return { startupControlIds: [4, 7] }; } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { runId: 'run', sessionId: 's', startupControlIds: [4, 7], ts: 42 });
  assert.equal(result.sessionId, 's');
});

test('IF-20 compact, resume, child and missing identity never enqueue or publish', async t => {
  const f = fixture(t);
  const options = { ...f, enqueue: async () => { throw Error('must not enqueue'); }, scopeReader: () => { throw Error('must not resolve'); } };
  for (const payload of [{ source: 'compact', session_id: 's' }, { source: 'resume', session_id: 's' },
    { source: 'startup', session_id: 's', agent_type: 'child' }, { source: 'startup' }]) {
    assert.equal((await publishBootstrapReady(payload, options)).skipped, true);
  }
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('IF-20 clear keeps old F3 on publication failure; enqueue failure can still publish empty IDs', async t => {
  const f = fixture(t), file = path.join(f.dir, 'current-session.json');
  fs.writeFileSync(file, 'old');
  await assert.rejects(publishBootstrapReady({ source: 'clear', session_id: 'new' }, { ...f,
    enqueue: async () => ({ startupControlIds: [] }), rename: () => { throw Error('rename failed'); } }), /rename failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  const record = await publishBootstrapReady({ source: 'clear', session_id: 'new' }, { ...f, enqueue: async () => { throw Error('queue unavailable'); } });
  assert.deepEqual(record.startupControlIds, []);
  assert.equal(record.sessionId, 'new');
});

test('IF-20 rejected managed identity leaves F3 untouched and does not enqueue', async t => {
  const f = fixture(t);
  await assert.rejects(publishBootstrapReady({ source: 'startup', session_id: 's' }, { ...f,
    identityReader: async () => { throw Error('stale'); }, enqueue: async () => { assert.fail('enqueue before identity'); } }), /stale/);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('P06 2.1 foreground identity uses actual runtime ancestry and rejects wrong pane or run', async () => {
  const scope = { kind: 'group', sessionGroup: 'origin' };
  const env = { ZYLOS_RUN_ID: 'r', ZYLOS_SESSION_GROUP: 'origin', TMUX_PANE: '%3' };
  const target = { present: true, runtime: 'codex', paneId: '%3', runId: 'r', rawF2: { ZYLOS_SESSION_GROUP: 'origin' } };
  let closed = 0;
  const options = { env, pid: 30, load: async () => ({ tmuxNameForGroup: () => 'zylos-group-origin' }),
    open: async () => ({ command: async () => '10', close: () => closed++ }), observe: async () => target,
    processTree: async () => [{ pid: 30, ppid: 20, name: 'node' }, { pid: 20, ppid: 10, name: 'codex' }, { pid: 10, ppid: 1, name: 'sh' }] };
  assert.equal((await readBootstrapIdentity(scope, options)).runtimePid, 20);
  await assert.rejects(readBootstrapIdentity(scope, { ...options, env: { ...env, TMUX_PANE: '%4' } }), { code: 'IDENTITY_UNAVAILABLE' });
  await assert.rejects(readBootstrapIdentity(scope, { ...options, env: { ...env, ZYLOS_RUN_ID: 'old' } }), { code: 'IDENTITY_UNAVAILABLE' });
  await assert.rejects(readBootstrapIdentity(scope, { ...options, processTree: async () => [{ pid: 30, ppid: 1, name: 'node' }] }), { code: 'IDENTITY_UNAVAILABLE' });
  assert.equal(closed, 4);
});
