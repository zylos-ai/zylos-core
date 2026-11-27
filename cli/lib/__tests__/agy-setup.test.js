import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncAgyConfig, agyConfigurationPaths, isAgyConfigReady, hasAgyZylosHooks } from '../runtime/agy/hooks.js';
import { groupCommand } from '../../commands/group.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, zylosDir: path.join(home, 'zylos') };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('Antigravity setup merges user settings, hooks, MCP servers and onboarding state', t => {
  const f = fixture(t), files = agyConfigurationPaths(f.home);
  for (const file of Object.values(files)) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(files.settings, JSON.stringify({ theme: 'dark', statusLine: { stack_with_default: true } }));
  fs.writeFileSync(files.hooks, JSON.stringify({ custom: { Stop: [{ command: './keep.sh' }] } }));
  fs.writeFileSync(files.mcp, JSON.stringify({ mcpServers: { custom: { command: 'keep' }, 'zylos-memory': { command: 'node', args: ['memory-mcp-server.js'] } }, custom: true }));
  fs.writeFileSync(files.onboarding, JSON.stringify({ enterpriseOnboardingComplete: false, custom: true }));
  assert.equal(hasAgyZylosHooks(f.home), false);
  assert.equal(syncAgyConfig(f).files.length, 4);
  assert.equal(hasAgyZylosHooks(f.home), true);
  assert.equal(read(files.settings).theme, 'dark');
  assert.equal(read(files.settings).modelProvider, 'gemini');
  assert.equal(read(files.settings).userDataCollectionForceDisabled, true);
  assert.equal(read(files.settings).statusLine.stack_with_default, true);
  const hooks = read(files.hooks);
  assert.equal(hooks.custom.Stop[0].command, './keep.sh');
  assert.equal(hooks.zylos.PreToolUse[0].matcher, '^ask_question$');
  assert.equal(hooks.zylos.PreToolUse[0].hooks[0].timeout, 5);
  assert.match(hooks.zylos.PreToolUse[0].hooks[0].command, /agy-tool-guard\.js'$/);
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const tool = hooks.zylos[event].find(group => group.matcher === '^run_command$');
    assert.equal(tool.hooks.length, 1);
    assert.equal(tool.hooks[0].timeout, 10);
    assert.ok(tool.hooks[0].command.endsWith(`agy-hooks.js' ${event}`));
  }
  for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.equal(hooks.zylos[event][0].timeout, 60);
    assert.match(hooks.zylos[event][0].command, new RegExp(`agy-hooks\\.js' ${event}$`));
  }
  assert.equal(read(files.mcp).mcpServers.custom.command, 'keep');
  assert.equal(Object.hasOwn(read(files.mcp).mcpServers, 'zylos-memory'), false);
  assert.deepEqual(read(files.onboarding), { enterpriseOnboardingComplete: false, custom: true, consumerOnboardingComplete: true, onboardingComplete: true });
  assert.equal(syncAgyConfig(f).changed, false);
  assert.equal(isAgyConfigReady(f), true);
});

test('Antigravity setup refuses malformed user JSON before any writes', t => {
  const f = fixture(t), files = agyConfigurationPaths(f.home);
  fs.mkdirSync(path.dirname(files.hooks), { recursive: true });
  fs.writeFileSync(files.hooks, 'broken');
  assert.throws(() => syncAgyConfig(f), { code: 'AGY_CONFIG_UNREADABLE' });
  assert.equal(fs.existsSync(files.settings), false);
  assert.equal(fs.readFileSync(files.hooks, 'utf8'), 'broken');
  assert.equal(isAgyConfigReady(f), false);
});

for (const ok of [true, false]) {
  test(`group runtime set ${ok ? 'installs before saving' : 'does not save when installation fails'}`, async t => {
    const previousExitCode = process.exitCode;
    t.after(() => { process.exitCode = previousExitCode; });
    const flags = ['set', '--group', 'telegram:example', '--runtime', 'agy', '--json'];
    const stdout = [], stderr = [], calls = [];
    const io = { stdout: { write: value => stdout.push(value) }, stderr: { write: value => stderr.push(value) } };
    const notices = [{ runtime: 'agy', message: 'N' }];
    const code = await groupCommand(['runtime', ...flags], {
      io,
      runtimeFor: id => ({ id, identity: { findExecutable: () => null } }),
      prepareCli: options => {
        calls.push(['prepare', options]);
        return ok ? { completed: ['agy.cli'], failed: [], installed: ['agy'], notices }
          : { failed: [{ item: 'agy.cli', message: 'M' }] };
      },
      run: (kind, args, passedIo) => {
        calls.push(['run', kind, args]);
        passedIo.stdout.write('{"ok":true}\n');
        return 0;
      },
    });
    assert.deepEqual(calls, [
      ['prepare', { runtimes: ['agy'] }],
      ...(ok ? [['run', 'runtime', flags]] : []),
    ]);
    assert.equal(code, ok ? 0 : 1);
    assert.deepEqual(stderr, ok ? ['Warning [RUNTIME_CLI_INSTALL_NOTICE]: N\n'] : []);
    assert.equal(stdout.length, 1);
    assert.deepEqual(JSON.parse(stdout[0]), ok ? { ok: true } : {
      ok: false, error: { code: 'RUNTIME_NOT_INSTALLED', message: 'M', persisted: [] },
    });
  });
}
