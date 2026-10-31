import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { groupCommand } from '../../commands/group.js';
import { resolveCliSession } from '../cli-session.js';

test('group delegates selector/actions verbatim to the formal wrapper', async () => {
  const previous = process.exitCode;
  try {
    for (const kind of ['runtime', 'model']) {
      const flags = ['get', '--group', 'telegram:example', '--runtime', 'codex', '--json'];
      const io = { stdout: {}, stderr: {} }; const calls = [];
      const result = await groupCommand([kind, ...flags], { io, run: async (...args) => { calls.push(args); return 1; } });
      assert.deepEqual(calls, [[kind, flags, io]]); assert.equal(result, 1); assert.equal(process.exitCode, 1);
    }
  } finally { process.exitCode = previous; }
});

test('CLI entry loads and invalid status arguments produce one structured result', () => {
  const cli = new URL('../../zylos.js', import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, 'status', '--json', '--unknown'], { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]); assert.equal(parsed.error.code, 'INVALID_ARGUMENT'); assert.deepEqual(parsed.error.persisted, []);
});

test('group text explains null running using mode before runtime comparison', async () => {
  const previous = process.exitCode;
  try {
    for (const [sessionMode, expected] of [['single', /only in multi/], ['multi', /current group runtime is claude/]]) {
      let text = '';
      await groupCommand(['model', 'get'], { io: { stdout: { write: value => { text += value; } }, stderr: {} },
        run: async (_kind, args, io) => { assert.equal(args.at(-1), '--json'); io.stdout.write(`${JSON.stringify({ ok: true, data: { running: null, sessionMode, runtime: 'codex', resolved: { runtime: 'claude' } } })}\n`); return 0; } });
      assert.match(text, expected);
    }
    let stdout = '', stderr = '';
    const code = await groupCommand(['runtime', 'get'], { io: { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } },
      run: async (_kind, _args, io) => { io.stdout.write(JSON.stringify({ ok: false, error: { code: 'DB_BUSY', message: 'busy', persisted: [] } })); return 1; } });
    assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /^Error \[DB_BUSY\]: busy\n$/);
  } finally { process.exitCode = previous; }
});

test('CLI session targets actual runtime and rejects unreadable mode without default fallback', async () => {
  for (const [mode, expected] of [['multi', 'telegram:example'], ['single', null], [null, null]]) {
    const seen = [];
    const result = await resolveCliSession({ env: { ZYLOS_SESSION_GROUP: 'telegram:example' }, mode: () => ({ mode }),
      identity: async group => { seen.push(group); return { present: true, runtime: 'codex' }; },
      resolveRuntime: () => assert.fail('present runtime must win'), adapter: runtime => runtime });
    assert.deepEqual(seen, [expected]); assert.equal(result.runtime, 'codex'); assert.equal(result.adapter, 'codex');
  }
  await assert.rejects(() => resolveCliSession({ mode: () => { throw new Error('bad config'); },
    identity: () => assert.fail('bad mode must stop target selection') }), /bad config/);
});
