import assert from 'node:assert/strict';
import test from 'node:test';
import { readReadiness } from '../src/lib/readiness.js';

function fixture({ mode = 'single', present = true, health = { missing: true }, responsive = true } = {}) {
  const calls = [];
  return { calls, load: async name => {
    calls.push(name);
    if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
    if (name === 'am-sock-client.js') return { submit: async (request, options) => {
      assert.equal(request.version, 0);
      assert.equal(request.type, 'restart_all');
      assert.deepEqual(options, { replyMaxMs: 1000 });
      return responsive ? { kind: 'rejected', reply: { code: 'invalid_request' } } : { kind: 'timeout' };
    } };
    if (name === 'session-state-reader.js') return {
      readLiveIdentity: async group => { assert.equal(group, null); calls.push('identity'); return { present }; },
      readRuntimeHealth: async () => health,
    };
    throw new Error('Unexpected module');
  } };
}

test('only supervisor response and confirmed single-session absence gate readiness', async () => {
  for (const mode of ['single', 'multi']) for (const present of [true, false]) for (const responsive of [true, false]) {
    const f = fixture({ mode, present, responsive });
    const result = await readReadiness(f);
    assert.equal(result.ready, responsive && (mode === 'multi' || present));
    assert.equal(result.reason, !responsive ? 'supervisor_unavailable' : mode === 'single' && !present ? 'session_not_running' : null);
    assert.equal(result.session_running, mode === 'single' ? present : null);
    assert.equal(f.calls.includes('identity'), mode === 'single');
  }
});

test('health projection preserves known states and excludes every other record field', async () => {
  for (const health of ['ok', 'auth_failed', 'rate_limited', 'unavailable', 'down', 'recovering']) {
    const result = await readReadiness(fixture({ health: { health, pid: 123, reason: '/private/path', runId: 'secret-run', hook: { tool: 'private-tool' } } }));
    assert.equal(result.ready, true);
    assert.deepEqual(result.runtime_health, { claude: { source: 'record', health }, codex: { source: 'record', health } });
    assert.deepEqual(Object.keys(result).sort(), ['ready', 'reason', 'runtime_health', 'session_mode', 'session_running']);
    assert.doesNotMatch(JSON.stringify(result), /private|secret|pid|hook|tool|runId/);
  }
});

test('unreadable observations remain unknown without becoming a third rejection gate', async () => {
  const f = fixture();
  const base = f.load;
  f.load = async name => {
    const module = await base(name);
    if (name === 'config.js') return { readSessionMode: () => { throw new Error('/private/config'); } };
    if (name === 'session-state-reader.js') return { readRuntimeHealth: () => { throw new Error('/private/health'); } };
    return module;
  };
  const result = await readReadiness(f);
  assert.equal(result.ready, true);
  assert.equal(result.session_mode, null);
  assert.equal(result.session_running, null);
  assert.deepEqual(result.runtime_health.claude, { source: 'unreadable', health: null });
  const absentMode = await readReadiness(fixture({ mode: null }));
  assert.equal(absentMode.session_mode, 'single');
  const brokenReader = fixture();
  const original = brokenReader.load;
  brokenReader.load = async name => name === 'session-state-reader.js' ? {
    readLiveIdentity: () => { throw new Error('/private/identity'); }, readRuntimeHealth: () => ({ missing: true }),
  } : original(name);
  assert.equal((await readReadiness(brokenReader)).session_running, null);
  assert.equal((await readReadiness(brokenReader)).ready, true);
  const incomplete = fixture({ present: undefined });
  const incompleteLoad = incomplete.load;
  incomplete.load = async name => name === 'session-state-reader.js' ? {
    readLiveIdentity: () => ({}), readRuntimeHealth: () => ({ missing: true }),
  } : incompleteLoad(name);
  assert.equal((await readReadiness(incomplete)).session_running, null);
});
