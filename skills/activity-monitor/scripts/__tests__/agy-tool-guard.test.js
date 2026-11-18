import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { guardAgyTool, runAgyToolGuard } from '../agy-tool-guard.js';

test('question dialogs are denied with a plain text alternative', () => {
  const result = guardAgyTool({ toolCall: { name: 'ask_question', args: {} } });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /plain text/);
});

test('other tools keep the native permission policy', () => {
  for (const payload of [{ toolCall: { name: 'run_command' } }, { toolCall: { name: 'invoke_subagent' } }]) {
    assert.deepEqual(guardAgyTool(payload), { decision: 'allow' });
  }
});

test('native hook entrypoint emits a denial as JSON on stdout', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../agy-tool-guard.js', import.meta.url))], {
    input: JSON.stringify({ toolCall: { name: 'ask_question' } }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).decision, 'deny');
});

for (const input of ['', '{broken', 'null', '{}']) test(`native guard denies unusable input ${JSON.stringify(input)}`, () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../agy-tool-guard.js', import.meta.url))], {
    input, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.error, undefined);
  assert.equal(JSON.parse(result.stdout).decision, 'deny');
  assert.equal(result.signal, null);
});

test('guard emits denial when the input stream errors', async () => {
  const input = new PassThrough();
  const result = new Promise(resolve => runAgyToolGuard({ input, complete: (body, code) => resolve({ body, code }) }));
  input.emit('error', new Error('stdin unavailable'));
  const { body, code } = await result;
  assert.equal(body.decision, 'deny');
  assert.equal(code, 1);
});

// Entrypoint subprocess boundary only: no runtime, tmux, DB or network access.
// Run for guard stdin/deadline changes; all child handles belong to this test.
test('native guard exits itself with JSON denial when stdin never closes', { timeout: 4000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../agy-tool-guard.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
  child.stdin.write('{');
  const result = await exited;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null, 'the hook must stop without an external timeout killing it');
  assert.equal(JSON.parse(stdout).decision, 'deny');
});
