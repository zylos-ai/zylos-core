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

test('Claude defaults reject damaged settings and create a missing file', async t => {
  const { file, config } = fixture(t);
  const actions = [
    ['switch-model', { runtime: 'claude', model: 'sonnet' }, { model: 'sonnet' }],
    ['switch-effort', { runtime: 'claude', effort: 'high' }, { effortLevel: 'high' }],
  ];
  for (const [name, original] of [
    ['truncated JSON', '{"model": "opus", "env": {"A": "1"'],
    ['array root', '[]'],
    ['missing file', null],
  ]) {
    await t.test(name, async () => {
      const { handleAction: dispatch } = await import(`../src/lib/actions.js?settings-content=${encodeURIComponent(name)}`);
      for (const [action, body, expected] of actions) {
        if (original === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, original);
        const result = await dispatch(action, body, config);
        if (original === null) {
          assert.equal(result.ok, true);
          assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(expected, null, 2) + '\n');
          continue;
        }
        assert.equal(result.ok, false);
        assert.equal(result.error, 'internal_error');
        assert.equal(result.messageKey, 'result.internal_error');
        assert.ok(result.message.includes(file));
        assert.equal(fs.readFileSync(file, 'utf8'), original);
      }
    });
  }
});
