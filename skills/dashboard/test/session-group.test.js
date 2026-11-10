import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSessionGroup } from '../scripts/session-group.js';

function query(args) {
  let stdout = '', stderr = '';
  const status = runSessionGroup(args, {
    stdout: { write: value => { stdout += value; } },
    stderr: { write: value => { stderr += value; } },
  });
  return { status, stdout, stderr };
}

test('Dashboard session query returns the exact ordinary local name', () => {
  for (const endpoint of ['conversation_a', 'A.b:c-d_9', 'a'.repeat(95)]) {
    const result = query([endpoint]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${endpoint}\n`);
    assert.equal(result.stderr, '');
  }
});

test('Dashboard session query rejects fixed origin invalid names and wrong argument counts', () => {
  for (const args of [[], ['one', 'two'], ['origin'], [''], [' name'], ['name '],
    ['a\nb'], ['../group'], ['-group'], ['a'.repeat(96)]]) {
    const result = query(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '', JSON.stringify(args));
    assert.ok(result.stderr.length > 0);
  }
});

// Boundary: actual query executable only; no database, service, runtime or socket.
// Run when changing the address query or CLI entry; skip for Dashboard UI-only edits.
test('Dashboard session query CLI writes only the local name and exits nonzero on rejection', () => {
  const script = fileURLToPath(new URL('../scripts/session-group.js', import.meta.url));
  const env = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
  for (const key of ['HOME', 'ZYLOS_DIR', 'TMPDIR']) assert.ok(env[key], `${key} must come from the isolated test runner`);
  console.log('Dashboard query isolation:', JSON.stringify({ ...env, database: 'none', tmux: 'not spawned' }));
  const invoke = args => spawnSync(process.execPath, [script, ...args], {
    env, encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
  });
  const accepted = invoke(['conversation_a']);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, 'conversation_a\n');
  assert.equal(accepted.stderr, '');
  for (const args of [['origin'], [], ['a', 'b'], ['bad name']]) {
    const rejected = invoke(args);
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.ok(rejected.stderr.length > 0);
  }
});
