import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardAgyTool } from '../agy-tool-guard.js';

test('question dialogs are denied with a plain text alternative', () => {
  const result = guardAgyTool({ toolCall: { name: 'ask_question', args: {} } });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /plain text/);
});

test('other tools keep the native permission policy', () => {
  for (const payload of [{ toolCall: { name: 'run_command' } }, {}, null]) {
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
