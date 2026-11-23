import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildKickPrompt } from '../../../../cli/lib/runtime/kick-prompt.js';
import { hooks } from '../../../../cli/lib/runtime/agy/hooks.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = fileURLToPath(new URL('../agy-hooks.js', import.meta.url));
const guard = fileURLToPath(new URL('../agy-tool-guard.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: repo,
    ZYLOS_RUN_ID: 'run', ZYLOS_MODEL_CONFIG: '{"runtime":"agy"}' };
  delete env.ZYLOS_SESSION_GROUP;
  return { root, env };
}

test('tool tracking allows execution after a lifecycle exception', t => {
  const { env } = fixture(t);
  const result = spawnSync(process.execPath, [entry, 'PreToolUse'], {
    env: { ...env, ZYLOS_SESSION_GROUP: '' }, input: '{"conversationId":"parent"}',
    encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { decision: 'allow' });
  assert.match(result.stderr, /Zylos AGY hook failed/);
});

test('native hook entrypoints emit bounded protocol responses with measured wall time', { timeout: 12000 }, t => {
  const { env } = fixture(t);
  hooks.mainSession.accept({ conversationId: 'parent', lastUserInput: buildKickPrompt() }, 'SessionStart', env);
  const toolCall = { id: 'command', name: 'run_command', args: { CommandLine: 'echo isolated', Cwd: env.ZYLOS_DIR } };
  const cases = [
    ['bare Node', fileURLToPath(new URL('./fixtures/empty-hook.js', import.meta.url)), null, {}],
    ['guard', guard, null, { toolCall: { name: 'ask_question' } }],
    ['PreInvocation', entry, 'PreInvocation', { conversationId: 'parent', invocationNum: 0 }],
    ['PreToolUse', entry, 'PreToolUse', { conversationId: 'parent', toolCall }],
    ['PostToolUse', entry, 'PostToolUse', { conversationId: 'parent', toolCall }],
    ['Stop', entry, 'Stop', { conversationId: 'parent', fullyIdle: true }],
    ['child SessionStart', entry, 'SessionStart', { conversationId: 'child' }],
  ];
  for (const [name, file, event, payload] of cases) {
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      const result = spawnSync(process.execPath, [file, ...(event ? [event] : [])], {
        env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 3000,
      });
      samples.push(performance.now() - started);
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.deepEqual(JSON.parse(result.stdout), name === 'guard'
        ? { decision: 'deny', reason: 'Ask the user in plain text instead of calling ask_question.' }
        : name === 'PreToolUse' ? { decision: 'allow' } : {});
    }
    samples.sort((a, b) => a - b);
    t.diagnostic(`${name}: n=6 min=${samples[0].toFixed(1)} median=${((samples[2] + samples[3]) / 2).toFixed(1)} max=${samples.at(-1).toFixed(1)} ms (includes Node startup)`);
  }
});
