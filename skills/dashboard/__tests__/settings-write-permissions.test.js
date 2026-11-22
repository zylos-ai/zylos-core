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
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    model: 'claude-fixture-existing', env: { KEEP: 'unchanged' },
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});

test('an effort change tightens world-readable project settings', async t => {
  const { file, config } = fixture(t, { model: 'opus', effortLevel: 'medium' });
  const result = await handleAction('switch-effort', { runtime: 'claude', effort: 'low' }, config);
  assert.equal(result.ok, true);
  assert.equal(mode(file), '600');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus', effortLevel: 'low' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});

test('an effort change creates missing project settings owner-only', async t => {
  const { file, config } = fixture(t);
  const result = await handleAction('switch-effort', { effort: 'medium' }, config);
  assert.equal(result.ok, true);
  assert.equal(mode(file), '600');
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "effortLevel": "medium"\n}\n');
});

const template = JSON.parse(fs.readFileSync(new URL('../../../templates/.claude/settings.json', import.meta.url)));
for (const [action, body, original, expected] of [
  ['switch-model', { model: 'sonnet' }, '{坏', { model: 'sonnet' }],
  ['switch-effort', { effort: 'high' }, '{坏', { effortLevel: 'high' }],
  ['switch-model', { model: template.model }, '[]', { model: template.model }],
]) {
  test(`Claude ${action} repairs project settings (${original}) and reports a changed save`, async t => {
    const { file, config } = fixture(t);
    const bytes = Buffer.from(original);
    fs.writeFileSync(file, bytes, { mode: 0o640 });
    const originalInode = fs.statSync(file).ino;
    const log = t.mock.method(console, 'log', () => {});

    const result = await handleAction(action, body, config);

    assert.equal(result.ok, true);
    assert.equal(result.requires_restart, true);
    assert.equal(mode(file), '600');
    const dir = path.dirname(file);
    const backups = fs.readdirSync(dir).filter(name => name.startsWith('settings.json.corrupt.'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^settings\.json\.corrupt\.\d+$/);
    const backup = path.join(dir, backups[0]);
    assert.deepEqual(fs.readFileSync(backup), bytes);
    assert.equal(fs.statSync(backup).ino, originalInode);
    assert.equal(mode(backup), '640');
    const { hooks, ...settings } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(settings, { ...template, ...expected });
    const startup = hooks.SessionStart.find(group => group.matcher === 'startup');
    assert.ok(startup.hooks.some(hook => hook.command.includes(path.join(config.zylosDir, '.claude', 'skills/activity-monitor/scripts/hook-health.js'))));
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [
      [`Claude settings were not valid JSON; moved to ${backup} and rebuilt from the template`],
    ]);
  });
}
