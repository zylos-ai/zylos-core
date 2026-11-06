import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleAction, getActionsMeta, readCodexRootString } from '../src/lib/actions.js';
import { formatActionResult } from '../public/js/action-result.js';

// Filesystem integration: real action validation and writes, private config files
// only. Run for runtime selection/model/effort changes; skip presentation changes.
// The isolated runner supplies HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private tmux.
// These actions never start a process or background loop. Every test owns and
// removes its temporary files via t.after, including assertion failures.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-default-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.mkdirSync(path.join(dir, '.codex'));
  const claude = path.join(dir, '.claude/settings.json');
  const codex = path.join(dir, '.codex/config.toml');
  fs.writeFileSync(claude, JSON.stringify({ model: 'opus', effortLevel: 'medium', permissions: { allow: [] } }));
  fs.writeFileSync(codex, 'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n[other]\nkeep = true\n');
  return { dir, claude, codex, config: { runtime: 'claude', zylosDir: dir } };
}

test('explicit Codex model changes project config while keeping Claude bytes', async t => {
  const { dir, claude, codex, config } = fixture(t), before = fs.readFileSync(claude, 'utf8');
  const result = await handleAction('switch-model', { runtime: 'codex', model: 'gpt-x' }, config);
  assert.equal(result.ok, true);
  assert.equal(result.runtime, 'codex');
  assert.equal(result.requires_restart, false);
  assert.equal(result.messageParams.runtime, 'codex');
  assert.equal(readCodexRootString('model', dir), 'gpt-x');
  assert.match(fs.readFileSync(codex, 'utf8'), /\[other\]\nkeep = true/);
  assert.equal(fs.readFileSync(claude, 'utf8'), before);
});

test('absent runtime retains active Claude behavior and unrelated settings', async t => {
  const { claude, codex, config } = fixture(t), before = fs.readFileSync(codex, 'utf8');
  const result = await handleAction('switch-model', { model: 'sonnet' }, config);
  assert.equal(result.ok, true);
  assert.equal(result.runtime, 'claude');
  assert.equal(result.requires_restart, true);
  assert.equal(JSON.parse(fs.readFileSync(claude)).model, 'sonnet');
  assert.deepEqual(JSON.parse(fs.readFileSync(claude)).permissions, { allow: [] });
  assert.equal(fs.readFileSync(codex, 'utf8'), before);
});

test('explicit invalid runtimes reject model and effort without either file changing', async t => {
  const { claude, codex, config } = fixture(t);
  const originals = [claude, codex].map(file => fs.readFileSync(file, 'utf8'));
  for (const runtime of ['foo', null, 0, '']) {
    for (const action of ['switch-model', 'switch-effort']) {
      const result = await handleAction(action, { runtime, model: 'unused', effort: 'high' }, config);
      assert.equal(result.error, 'INVALID_RUNTIME');
    }
  }
  for (const [i, file] of [claude, codex].entries()) assert.equal(fs.readFileSync(file, 'utf8'), originals[i]);
});

test('effort writes target each selected runtime and metadata reads saved defaults', async t => {
  const { dir, claude, codex, config } = fixture(t);
  const beforeClaude = fs.readFileSync(claude, 'utf8');
  const codexResult = await handleAction('switch-effort', { runtime: 'codex', effort: 'high' }, config);
  assert.equal(codexResult.ok, true);
  assert.equal(codexResult.requires_restart, false);
  assert.equal(codexResult.messageParams.runtime, 'codex');
  assert.equal(fs.readFileSync(claude, 'utf8'), beforeClaude);
  assert.equal(readCodexRootString('model_reasoning_effort', dir), 'high');
  const beforeCodex = fs.readFileSync(codex, 'utf8');
  const claudeResult = await handleAction('switch-effort', { runtime: 'claude', effort: 'low' }, config);
  assert.equal(claudeResult.ok, true);
  assert.equal(claudeResult.requires_restart, false);
  assert.equal(JSON.parse(fs.readFileSync(claude)).effortLevel, 'low');
  assert.equal(fs.readFileSync(codex, 'utf8'), beforeCodex);
  assert.equal(getActionsMeta(config, null).current_effort, 'low');
  assert.equal(getActionsMeta({ ...config, runtime: 'codex' }, null).current_effort, 'high');
});

// Same private filesystem-only lifecycle as fixture; run for default effort
// response semantics, skip UI-only edits. No child processes or timers start.
test('effort without runtime retains the legacy restart request', async t => {
  const { claude, config } = fixture(t);
  const result = await handleAction('switch-effort', { effort: 'high' }, config);
  assert.equal(result.ok, true);
  assert.equal(result.runtime, 'claude');
  assert.equal(result.requires_restart, true);
  assert.equal(JSON.parse(fs.readFileSync(claude)).effortLevel, 'high');
});

// Unit boundary: real action adapter + formatter, with the Core action replaced
// before a fresh adapter import. No CLI, HTTP server, files or background loops.
// Run for runtime rejection presentation changes; skip unrelated price changes.
test('runtime authentication rejection keeps the Core reason visible through action formatting', async t => {
  const reason = Object.freeze({ code: 'AUTH_NOT_CONFIRMED', message: 'Please confirm the runtime login.' });
  const rejected = Object.freeze({ ok: false, error: reason, messageKey: 'result.runtime_unknown', messageParams: { value: 'codex' } });
  let response = rejected, calls = 0;
  const core = t.mock.module('../src/lib/core-actions.js', { namedExports: {
    handleCoreAction: async (action, body) => {
      calls++;
      assert.equal(action, 'switch-runtime');
      assert.ok(['claude', 'codex'].includes(body.runtime));
      return response;
    },
  } });
  t.after(() => core.restore());
  const { handleAction: dispatch } = await import('../src/lib/actions.js?runtime-auth-reason');
  const config = { runtime: 'claude', zylosDir: process.env.ZYLOS_DIR };
  const result = await dispatch('switch-runtime', { runtime: 'codex' }, config);
  const translate = key => key === 'result.runtime_unknown' ? 'Runtime result is unknown.' : key;
  assert.equal(result.ok, false);
  assert.equal(result.error, reason);
  assert.equal(result.messageParams, rejected.messageParams);
  assert.equal(rejected.messageKey, 'result.runtime_unknown');
  assert.equal(formatActionResult(result, translate), 'AUTH_NOT_CONFIRMED: Please confirm the runtime login.');
  response = { ok: false, error: { code: 'RESULT_UNKNOWN' }, messageKey: 'result.runtime_unknown' };
  const unknown = await dispatch('switch-runtime', { runtime: 'claude' }, config);
  assert.equal(unknown, response);
  assert.equal(formatActionResult(unknown, translate), 'Runtime result is unknown.');
  assert.equal(calls, 2);
});
