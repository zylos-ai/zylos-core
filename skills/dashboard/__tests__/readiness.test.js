import assert from 'node:assert/strict';
import test from 'node:test';
import { readReadiness } from '../src/lib/readiness.js';

function fixture({ mode = 'single', health = { missing: true }, responsive = true } = {}) {
  const calls = [];
  return { calls, load: async name => {
    calls.push(name);
    if (name === 'config.js') return { readSessionMode: () => ({ mode, keyPresent: mode !== null }) };
    if (name === 'am-sock-client.js') return { submit: async (request, options) => {
      assert.equal(request.version, 0);
      assert.equal(request.type, 'restart_all');
      assert.deepEqual(options, { replyMaxMs: 1000 });
      return responsive ? { kind: 'rejected', reply: { code: 'invalid_request' } } : { kind: 'timeout' };
    } };
    if (name === 'session-state-reader.js') return {
      readLiveIdentity: async () => { calls.push('identity'); return { present: false }; },
      readRuntimeHealth: async () => health,
    };
    throw new Error('Unexpected module');
  } };
}

test('health projection preserves known states and excludes every other record field', async () => {
  for (const health of ['ok', 'auth_failed', 'rate_limited', 'unavailable', 'down', 'recovering']) {
    const result = await readReadiness(fixture({ health: { health, pid: 123, reason: '/private/path', runId: 'secret-run', hook: { tool: 'private-tool' } } }));
    assert.equal(result.ready, true);
    assert.deepEqual(result.runtime_health, { claude: { source: 'record', health }, codex: { source: 'record', health }, agy: { source: 'record', health } });
    assert.deepEqual(Object.keys(result).sort(), ['ready', 'reason', 'runtime_health', 'session_mode', 'session_running']);
    assert.doesNotMatch(JSON.stringify(result), /private|secret|pid|hook|tool|runId/);
  }
});
