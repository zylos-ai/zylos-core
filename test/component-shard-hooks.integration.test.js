import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { desiredClaudeHooks, syncHooks } from '../cli/lib/sync-runtime-hooks.js';
import { codexHooksPath, installCoreCodexHook } from '../cli/lib/codex-hooks.js';

// Boundary: real declaration loading and Claude reconciliation, real Codex file
// synchronization, then the actual content-shard CLI emitting startup context.
// Run when declaration compatibility or component-hook preservation changes;
// unrelated docs/UI edits may skip. Official runner isolates HOME/ZYLOS_DIR/
// PM2_HOME/short TMPDIR. Every child gets fixture-owned paths, has a timeout and
// bounded output, and exits before fixture cleanup. No model, network, tmux or
// services are started; this proves hook output, not model context attachment.
test('a legacy shard declaration warns and emits while synchronization preserves component and user hooks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), zylosDir = path.join(home, 'zylos');
  for (const dir of ['.claude/skills/demo', '.codex', '.zylos/shards.d']) fs.mkdirSync(path.join(zylosDir, dir), { recursive: true });
  for (const dir of ['tmp', 'pm2', 'tmux']) fs.mkdirSync(path.join(root, dir));
  const legacy = { type: 'command', command: `node ${path.join(zylosDir, '.claude/skills/demo/old-session-start.js')}`, timeout: 7 };
  const other = { type: 'command', command: `node ${path.join(zylosDir, '.claude/skills/demo/unclaimed.js')}` };
  const user = { type: 'command', command: `node ${path.join(home, 'user-hook.js')}`, async: true };
  const group = { matcher: 'startup', customMetadata: 'preserve', hooks: [legacy, other, user] };
  const initial = { custom: { preserve: true }, hooks: { SessionStart: [group], Stop: [{ matcher: '*', hooks: [legacy] }] } };
  fs.writeFileSync(path.join(zylosDir, '.zylos/shards.d/demo.json'), JSON.stringify({
    name: 'demo', order: 10, emitter: 'skills/demo/emit-context.mjs',
    claimHooks: ['skills/demo/old-session-start.js'],
  }));
  fs.writeFileSync(path.join(zylosDir, '.claude/skills/demo/emit-context.mjs'), 'export const emit = () => "COMPONENT_CONTEXT_PRESENT";\n');
  fs.writeFileSync(path.join(zylosDir, '.claude/settings.json'), JSON.stringify(initial));
  fs.writeFileSync(codexHooksPath(zylosDir), JSON.stringify(initial));
  const settings = JSON.parse(fs.readFileSync(path.join(zylosDir, '.claude/settings.json'), 'utf8'));
  const options = { zylosDir, desiredHooks: desiredClaudeHooks({ zylosDir, existsSync: () => true }), log: () => {} };
  syncHooks(settings, {}, options);
  fs.writeFileSync(path.join(zylosDir, '.claude/settings.json'), JSON.stringify(settings));
  installCoreCodexHook({ zylosDir });
  for (const config of [settings, JSON.parse(fs.readFileSync(codexHooksPath(zylosDir), 'utf8'))]) {
    const preserved = config.hooks.SessionStart.find(g => g.customMetadata === 'preserve');
    assert.equal(preserved.matcher, group.matcher);
    assert.deepEqual(preserved.hooks.filter(h => [legacy.command, other.command, user.command].includes(h.command)), group.hooks);
    assert.deepEqual(config.hooks.Stop.find(g => g.matcher === '*'), initial.hooks.Stop[0]);
    assert.equal(config.custom.preserve, true);
    assert.ok(config.hooks.SessionStart.flatMap(g => g.hooks).some(h => h.command.endsWith('--shard demo')));
  }
  const before = JSON.stringify(settings);
  assert.deepEqual(syncHooks(settings, {}, options), { added: 0, updated: 0, removed: 0 });
  assert.equal(JSON.stringify(settings), before);
  const codexBefore = fs.readFileSync(codexHooksPath(zylosDir), 'utf8');
  assert.equal(installCoreCodexHook({ zylosDir }).changed, false);
  assert.equal(fs.readFileSync(codexHooksPath(zylosDir), 'utf8'), codexBefore);

  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir, CODEX_HOME: path.join(home, '.codex'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'),
    ZYLOS_PACKAGE_ROOT: path.resolve(import.meta.dirname, '..') };
  for (const key of ['ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'CODEX_HOME']) {
    assert.ok(env[key].startsWith(root + path.sep), `${key} must be fixture-owned`);
  }
  t.diagnostic('isolated child paths: ' + JSON.stringify(Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(k => [k, env[k]]))));
  const output = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, '../skills/activity-monitor/scripts/session-start-orchestrator.js'), '--shard', 'demo',
  ], { env, cwd: zylosDir, input: JSON.stringify({ source: 'startup' }), encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.equal(output.error, undefined);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout.split('COMPONENT_CONTEXT_PRESENT').length - 1, 1);
  assert.match(output.stderr, /claimHooks is ignored.*component must remove.*post-upgrade/);
  t.diagnostic('content occurrences=1; retired field warning observed; both runtime legacy hooks preserved');
});
