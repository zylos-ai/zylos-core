import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../config.js';
import { prepareInitRuntimeClis, prepareInitRuntimeAssets, reportInitPreparation, ensureInitMemoryMigration, parseInitFlags, initCommand, runInitNativeLogin } from '../../commands/init.js';

test('init prepares both CLIs idempotently and continues after one failure', async () => {
  const installed = new Set(['claude']); const calls = [];
  const deps = { exists: runtime => installed.has(runtime), install: {
    claude: () => { throw new Error('already installed'); },
    codex: () => { calls.push('codex'); installed.add('codex'); return true; },
  } };
  const result = await prepareInitRuntimeClis(deps);
  assert.deepEqual(result.completed, ['claude.cli', 'codex.cli']); assert.deepEqual(result.failed, []);
  await prepareInitRuntimeClis(deps); assert.deepEqual(calls, ['codex']);
  const partial = await prepareInitRuntimeClis({ exists: runtime => runtime === 'codex', install: { claude: () => false } });
  assert.deepEqual(partial.completed, ['codex.cli']); assert.equal(partial.failed[0].item, 'claude.cli');
});

test('init prepares both hook/instruction sets and reports partial completion', async () => {
  const calls = [];
  const result = await prepareInitRuntimeAssets({ instruction: runtime => { calls.push(`${runtime}.instruction`); return runtime; },
    exists: () => true, hooks: { claude: () => calls.push('claude.hooks'), codex: () => { throw new Error('trust'); } } });
  assert.deepEqual(calls, ['claude.instruction', 'claude.hooks', 'codex.instruction']);
  assert.deepEqual(result.completed, ['claude.instructions', 'claude.hooks', 'codex.instructions']);
  assert.deepEqual(result.failed, [{ item: 'codex.hooks', message: 'trust' }]);
  const lines = []; reportInitPreparation(result, line => lines.push(line));
  assert.match(lines[0], /部分完成/); assert.match(lines.join('\n'), /Failed: codex.hooks/);
});

test('init --json text compatibility and unknown argument rejection', () => {
  assert.deepEqual(parseInitFlags(['--json']), parseInitFlags([]));
  assert.throws(() => parseInitFlags(['--bad']), /Unknown init option/);
});

test('init refuses corrupt before running any installation/auth stage', async t => {
  const previous = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE) : null;
  t.after(() => {
    if (previous === null) fs.rmSync(CONFIG_FILE, { force: true });
    else fs.writeFileSync(CONFIG_FILE, previous);
  });
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, '{broken');
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  await assert.rejects(() => initCommand(['--json', '-y']), error => error.code === 'CONFIG_UNREADABLE');
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('init migration uses reusable ensure with fresh flag only on fresh install', async () => {
  for (const freshInstall of [true, false]) {
    const calls = [];
    await ensureInitMemoryMigration({ freshInstall, load: async () => ({ createMigration: () => ({ ensure: options => { calls.push(options); return { state: 'done' }; } }) }) });
    assert.deepEqual(calls, [{ createdBy: 'init', freshInstall }]);
  }
});

test('init warns on the migration unreadable status without replacing the record', async () => {
  const warnings = [];
  const status = { state: 'unreadable', warning: 'RECORD_UNREADABLE' };
  const result = await ensureInitMemoryMigration({
    load: async () => ({ createMigration: () => ({ ensure: () => status }) }),
    warn: message => warnings.push(message),
  });
  assert.equal(result, status);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RECORD_UNREADABLE/);
});

test('init native cancellation selects 130 independently of prior partial failures', () => {
  for (const native of [{ signal: 'SIGINT' }, { status: 130 }]) {
    const exits = [];
    runInitNativeLogin('codex', ['login'], { spawn: () => native, exit: code => exits.push(code) });
    assert.deepEqual(exits, [130]);
  }
  runInitNativeLogin('codex', ['login'], { spawn: () => ({ status: 0 }), exit: () => assert.fail('successful login must continue') });
});
