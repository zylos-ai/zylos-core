import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { desiredClaudeHooks, syncHooks } from '../sync-runtime-hooks.js';
import { codexHooksPath, installCoreCodexHook } from '../codex-hooks.js';
import { HOOK_ENTRY_SCRIPT, hookEntryTarget } from '../hook-utils.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A fresh zylos directory under the runner's isolated ZYLOS_DIR, with an assembler and one component shard. */
function zylosDir(t, name) {
  const dir = path.join(process.env.ZYLOS_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.zylos', 'instructions'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zylos', 'instructions', 'assembler.mjs'), '');
  fs.mkdirSync(path.join(dir, '.zylos', 'shards.d'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zylos', 'shards.d', 'expert-slot.json'),
    JSON.stringify({ name: 'expert-slot', order: 10, emitter: 'skills/expert-slot/emit.js' }));
  return dir;
}

const commandsOf = hooks => Object.values(hooks).flat().flatMap(group => group.hooks.map(hook => hook.command));

function assertThroughEntry(commands, dir) {
  const entry = path.join(dir, '.claude', HOOK_ENTRY_SCRIPT);
  for (const command of commands) {
    assert.ok(command.startsWith('exec node '), command);
    assert.ok(command.includes(entry), command);
    const target = hookEntryTarget(command);
    assert.ok(target && path.isAbsolute(target) && target.startsWith(dir + path.sep), command);
    assert.ok(fs.existsSync(path.join(repoRoot, path.relative(path.join(dir, '.claude'), target))) || target.endsWith('assembler.mjs'),
      `target ships with the package: ${target}`);
  }
}

test('every Claude hook zylos installs, with all optional events on, runs through the hook entry', t => {
  const dir = zylosDir(t, 'claude-hooks');
  const hooks = desiredClaudeHooks({ zylosDir: dir, stopFailureSupported: true, subagentHooksSupported: true });
  for (const event of ['SessionStart', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PermissionRequest']) {
    assert.ok(hooks[event], event);
  }
  const commands = commandsOf(hooks);
  assert.ok(commands.some(command => command.includes('--shard expert-slot')), 'component shard is present');
  assert.ok(commands.some(command => hookEntryTarget(command)?.endsWith('assembler.mjs')), 'assembler is present');
  assertThroughEntry(commands, dir);
});

test('every Codex hook zylos installs, including component shards, runs through the hook entry', t => {
  const dir = zylosDir(t, 'codex-hooks');
  const preview = installCoreCodexHook({ zylosDir: dir, dryRun: true });
  assert.equal(preview.changed, true);
  assert.equal(fs.existsSync(codexHooksPath(dir)), false, 'dry run writes nothing');
  assert.ok(preview.commands.some(command => command.endsWith('--shard expert-slot')));
  assertThroughEntry(preview.commands, dir);

  installCoreCodexHook({ zylosDir: dir });
  const config = JSON.parse(fs.readFileSync(codexHooksPath(dir), 'utf8'));
  assertThroughEntry(commandsOf(config.hooks), dir);
});

test('the statusLine template runs through the hook entry', () => {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, 'templates', '.claude', 'settings.json'), 'utf8'));
  const command = template.statusLine.command;
  assert.match(command, /^exec node ~\/zylos\/\.claude\/skills\/activity-monitor\/scripts\/hook-entry\.js /);
  assert.equal(hookEntryTarget(command), path.join(process.env.HOME, 'zylos', '.claude', 'skills', 'activity-monitor', 'scripts', 'context-monitor.js'));
});

test('direct Claude hook commands from earlier versions are replaced in place', t => {
  const dir = process.env.ZYLOS_DIR;
  const scripts = path.join(dir, '.claude', 'skills', 'activity-monitor', 'scripts');
  const desired = desiredClaudeHooks({ zylosDir: dir, stopFailureSupported: true, subagentHooksSupported: true });
  const installed = { hooks: {
    Stop: [{ hooks: [
      { type: 'command', command: `node ${path.join(scripts, 'hook-health.js')}`, timeout: 5 },
      { type: 'command', command: `node ${path.join(scripts, 'hook-activity.js')}`, async: true, timeout: 5 },
      { type: 'command', command: 'node /opt/custom/my-hook.js' },
    ] }],
  } };
  syncHooks(installed, {}, { desiredHooks: desired, zylosDir: dir, log: () => {} });
  const stop = installed.hooks.Stop.flatMap(group => group.hooks.map(hook => hook.command));
  assert.deepEqual(stop.filter(command => command.includes(scripts)).map(hookEntryTarget).sort(),
    [path.join(scripts, 'hook-activity.js'), path.join(scripts, 'hook-health.js')]);
  assert.ok(stop.includes('node /opt/custom/my-hook.js'), 'user hooks are kept');
  assertThroughEntry(commandsOf(installed.hooks).filter(command => command.includes(path.join(dir, '.claude'))), dir);
});

test('direct Codex hook commands from earlier versions are replaced in place', t => {
  const dir = zylosDir(t, 'codex-upgrade');
  const scripts = path.join(dir, '.claude', 'skills', 'activity-monitor', 'scripts');
  fs.mkdirSync(path.dirname(codexHooksPath(dir)), { recursive: true });
  fs.writeFileSync(codexHooksPath(dir), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `node ${path.join(scripts, 'session-start-orchestrator.js')} --shard memory` }] }],
    Stop: [{ hooks: [{ type: 'command', command: `node ${path.join(scripts, 'hook-activity.js')}` },
      { type: 'command', command: 'node /opt/custom/my-hook.js' }] }],
  } }));
  installCoreCodexHook({ zylosDir: dir });
  const config = JSON.parse(fs.readFileSync(codexHooksPath(dir), 'utf8'));
  const stop = commandsOf({ Stop: config.hooks.Stop });
  assert.equal(stop.filter(command => command.includes('hook-activity.js')).length, 1);
  assert.ok(stop.includes('node /opt/custom/my-hook.js'));
  assertThroughEntry(commandsOf(config.hooks).filter(command => command.includes(scripts)), dir);
});
