import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleAction, instanceDefaults } from '../src/lib/actions.js';

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
  assert.equal(instanceDefaults('codex', dir).model, 'gpt-x');
  assert.match(fs.readFileSync(codex, 'utf8'), /\[other\]\nkeep = true/);
  assert.equal(fs.readFileSync(claude, 'utf8'), before);
});

// Same private filesystem-only lifecycle as fixture; run for default effort
// response semantics, skip UI-only edits. No child processes or timers start.

// Unit boundary: real action adapter + formatter, with the Core action replaced
// before a fresh adapter import. No CLI, HTTP server, files or background loops.
// Run for runtime rejection presentation changes; skip unrelated price changes.

// Run for changes to default model confirmation, target selection or restart
// feedback. The real action writes only the private fixture, while session
// discovery and the supervisor socket are supplied as inert fixture boundaries.
