import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { acceptAgyMainEvent } from '../agy-main-session.js';
import { buildKickPrompt } from '../../../../cli/lib/runtime/kick-prompt.js';

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

function coreWithInstructions(root, instructions) {
  const fake = path.join(root, 'core'), lib = path.join(fake, 'cli/lib');
  fs.mkdirSync(path.join(lib, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'package.json'), '{"type":"module"}');
  for (const name of fs.readdirSync(path.join(repo, 'cli/lib'))) {
    if (name !== 'runtime') fs.symlinkSync(path.join(repo, 'cli/lib', name), path.join(lib, name));
  }
  for (const name of fs.readdirSync(path.join(repo, 'cli/lib/runtime'))) {
    const source = name === 'instruction-builder.js'
      ? fileURLToPath(new URL(`./fixtures/${instructions}`, import.meta.url)) : path.join(repo, 'cli/lib/runtime', name);
    fs.symlinkSync(source, path.join(lib, 'runtime', name));
  }
  return fake;
}

// Isolated native Node entrypoints only: no agy, service, tmux or network.
// Run for process lifetime/stdin/import changes; all subprocesses are synchronous,
// bounded and reaped. The fallback timeout is a failure, never the expected stop.
test('hook process deadline covers an import retaining a live handle', { timeout: 9000 }, t => {
  const { root, env } = fixture(t);
  const fake = coreWithInstructions(root, 'hanging-instructions.js');
  const result = spawnSync(process.execPath, [entry, 'PreInvocation'], {
    env: { ...env, ZYLOS_PACKAGE_ROOT: fake }, input: '{}', encoding: 'utf8', timeout: 7000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.match(result.stderr, /process deadline/);
});

test('tool tracking allows a child conversation without binding it as main', t => {
  const { root, env } = fixture(t);
  acceptAgyMainEvent({ conversationId: 'parent', lastUserInput: buildKickPrompt() }, 'SessionStart', env);
  const file = path.join(root, 'activity-monitor/session-groups/origin/agy-main-session.json');
  const before = fs.readFileSync(file, 'utf8');
  const result = spawnSync(process.execPath, [entry, 'PreToolUse'], {
    env, input: JSON.stringify({ conversationId: 'child', toolCall: { id: 'child-command', name: 'run_command', args: {} } }),
    encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { decision: 'allow' });
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('tool tracking allows execution when an import reaches the process deadline', { timeout: 9000 }, t => {
  const { root, env } = fixture(t);
  const fake = coreWithInstructions(root, 'hanging-instructions.js');
  const result = spawnSync(process.execPath, [entry, 'PreToolUse'], {
    env: { ...env, ZYLOS_PACKAGE_ROOT: fake }, input: '{}', encoding: 'utf8', timeout: 7000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { decision: 'allow' });
  assert.match(result.stderr, /process deadline/);
});

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

// The import resolves, so the hook reaches JSON output while a referenced
// interval remains live. Removing the explicit successful exit must hit timeout.
test('hook exits after protocol output when a resolved module retains a live handle', { timeout: 9000 }, t => {
  const { root, env } = fixture(t);
  const fake = coreWithInstructions(root, 'retained-handle-instructions.js');
  const started = performance.now();
  const result = spawnSync(process.execPath, [entry, 'PreInvocation'], {
    env: { ...env, ZYLOS_PACKAGE_ROOT: fake }, input: '{}', encoding: 'utf8', timeout: 7000,
  });
  const elapsed = performance.now() - started;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(result.stderr, '');
  assert.ok(elapsed < 2000, `hook took ${elapsed.toFixed(1)} ms; expected less than 2000 ms`);
  t.diagnostic(`resolved module with live interval: ${elapsed.toFixed(1)} ms (7000 ms subprocess timeout)`);
});

test('native hook entrypoints emit bounded protocol responses with measured wall time', { timeout: 12000 }, t => {
  const { env } = fixture(t);
  acceptAgyMainEvent({ conversationId: 'parent', lastUserInput: buildKickPrompt() }, 'SessionStart', env);
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
