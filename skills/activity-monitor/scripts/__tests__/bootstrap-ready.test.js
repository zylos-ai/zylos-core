import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishBootstrapReady } from '../bootstrap-ready.js';
import { readBootstrapIdentity } from '../bootstrap-identity.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-control-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const processReader = () => ({ runtimePid: 10, runtimeStart: '100', runtimeParentPid: 1, runtimeParentStart: '50' });
  return { env: { ZYLOS_RUN_ID: 'run' }, scopeReader: async () => ({ dir }), identityReader: async () => ({ runtime: 'codex' }), processReader, dir };
}

test('local publication follows enqueue and retains the exact control IDs', async t => {
  const f = fixture(t), file = path.join(f.dir, 'current-session.json');
  const result = await publishBootstrapReady({ source: 'startup', session_id: 's' }, { ...f, now: () => 42,
    enqueue: async () => { assert.equal(fs.existsSync(file), false); return { startupControlIds: [4, 7] }; } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { runId: 'run', sessionId: 's', startupControlIds: [4, 7], startupPrompt: { state: 'enqueued' }, ts: 42,
    runtimePid: 10, runtimeStart: '100', runtimeParentPid: 1, runtimeParentStart: '50' });
  assert.equal(result.sessionId, 's');
});

test('compact, resume, child and missing identity never enqueue or publish', async t => {
  const f = fixture(t);
  const options = { ...f, enqueue: async () => { throw Error('must not enqueue'); }, scopeReader: () => { throw Error('must not resolve'); } };
  for (const payload of [{ source: 'compact', session_id: 's' }, { source: 'resume', session_id: 's' },
    { source: 'startup', session_id: 's', agent_type: 'child' }, { source: 'startup' }]) {
    assert.equal((await publishBootstrapReady(payload, options)).skipped, true);
  }
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('READY identity binds the current run and pane without process ancestry', async () => {
  const scope = { kind: 'group', sessionGroup: 'origin' };
  const env = { ZYLOS_RUN_ID: 'r', ZYLOS_SESSION_GROUP: 'origin', TMUX_PANE: '%3' };
  const target = { present: true, runtime: 'codex', paneId: '%3', runId: 'r', rawF2: { ZYLOS_SESSION_GROUP: 'origin' } };
  let closed = 0;
  const options = { env, pid: 30, load: async () => ({ tmuxNameForGroup: () => 'zylos-group-origin' }),
    open: async () => ({ command: async () => '10', close: () => closed++ }), observe: async () => target,
    processTree: async () => assert.fail('managed READY must not inspect process ancestry') };
  assert.equal((await readBootstrapIdentity(scope, options)).runtime, 'codex');
  await assert.rejects(readBootstrapIdentity(scope, { ...options, env: { ...env, TMUX_PANE: '%4' } }), { code: 'IDENTITY_UNAVAILABLE' });
  await assert.rejects(readBootstrapIdentity(scope, { ...options, env: { ...env, ZYLOS_RUN_ID: 'old' } }), { code: 'IDENTITY_UNAVAILABLE' });
  assert.equal(closed, 3);
});

