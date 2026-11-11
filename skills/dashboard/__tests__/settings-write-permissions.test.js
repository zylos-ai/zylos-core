import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleAction } from '../src/lib/actions.js';

// Filesystem boundary: real model/effort actions writing the project Claude
// settings, which may carry credentials in env. Run when those actions or the
// owner-only file helpers change; skip presentation changes. The isolated runner
// supplies HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private tmux. No process, timer or
// background loop starts; every test removes its temporary files via t.after.
function fixture(t, settings) {
  const umask = process.umask(0o022);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-write-mode-'));
  t.after(() => {
    process.umask(umask);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, '.claude'));
  const file = path.join(dir, '.claude', 'settings.json');
  if (settings) {
    fs.writeFileSync(file, JSON.stringify(settings));
    fs.chmodSync(file, 0o644);
  }
  return { file, config: { runtime: 'claude', zylosDir: dir } };
}
const mode = file => (fs.statSync(file).mode & 0o777).toString(8);

test('a model change creates missing project settings owner-only', async t => {
  const { file, config } = fixture(t);
  const result = await handleAction('switch-model', { runtime: 'claude', model: 'claude-fixture-new' }, config);
  assert.equal(result.ok, true);
  assert.equal(mode(file), '600');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'claude-fixture-new');
});

test('a model change tightens world-readable project settings', async t => {
  const { file, config } = fixture(t, { model: 'opus', env: { KEEP: 'unchanged' } });
  const result = await handleAction('switch-model', { runtime: 'claude', model: 'claude-fixture-existing' }, config);
  assert.equal(result.ok, true);
  assert.equal(mode(file), '600');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.KEEP, 'unchanged');
});

test('an effort change tightens world-readable project settings', async t => {
  const { file, config } = fixture(t, { model: 'opus', effortLevel: 'medium' });
  const result = await handleAction('switch-effort', { runtime: 'claude', effort: 'low' }, config);
  assert.equal(result.ok, true);
  assert.equal(mode(file), '600');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).effortLevel, 'low');
});
