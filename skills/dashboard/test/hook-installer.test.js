import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HookInstaller } from '../src/lib/hook-installer.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-installer-test-'));
}

function makeInstaller(projectRoot, tmpHome) {
  const installer = new HookInstaller(projectRoot, tmpHome);
  const codexHome = path.join(tmpHome, 'codex-home');
  installer._codexHome = () => codexHome;
  installer._codexConfigPath = () => path.join(codexHome, 'config.toml');
  installer._trustCodexHooks = () => ({ trusted: 6, status: 'ok' });
  return installer;
}

test('HookInstaller — Claude', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('install creates hook entries for all 7 events', () => {
    const result = installer.installClaudeHooks();
    assert.equal(result.added, 7);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest', 'SubagentStart', 'SubagentStop']) {
      assert.ok(settings.hooks[event], `missing event ${event}`);
      assert.ok(settings.hooks[event].length > 0);
    }
  });

  await t.test('idempotent — second install adds nothing', () => {
    const result = installer.installClaudeHooks();
    assert.equal(result.added, 0);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest', 'SubagentStart', 'SubagentStop']) {
      assert.equal(settings.hooks[event].length, 1);
    }
  });

  await t.test('tool events have matcher, non-tool events do not', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].matcher, '');
    assert.equal(settings.hooks.PostToolUse[0].matcher, '');
    assert.equal(settings.hooks.UserPromptSubmit[0].matcher, undefined);
    assert.equal(settings.hooks.Stop[0].matcher, undefined);
    assert.equal(settings.hooks.PermissionRequest[0].matcher, undefined);
  });

  await t.test('hooks are registered as async with short timeout', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest', 'SubagentStart', 'SubagentStop']) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.equal(hook.async, true, `${event} hook should be async`);
      assert.equal(hook.timeout, 5, `${event} hook timeout should be 5ms`);
    }
  });

  await t.test('preserves existing hooks', () => {
    const existingHook = {
      hooks: [{ type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js', timeout: 5 }],
      matcher: ''
    };
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.hooks.PreToolUse.unshift(existingHook);
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    installer.installClaudeHooks();

    const after = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(after.hooks.PreToolUse.length, 2);
    assert.ok(after.hooks.PreToolUse[0].hooks[0].command.includes('activity-monitor'));
  });

  await t.test('upgrades existing sync hooks to async in-place', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest', 'SubagentStart', 'SubagentStop']) {
      if (!settings.hooks[event]) continue;
      for (const group of settings.hooks[event]) {
        for (const h of group.hooks || []) {
          if (installer._isOwn(h.command)) {
            h.timeout = 2000;
            delete h.async;
          }
        }
      }
    }
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.installClaudeHooks();
    assert.ok(result.added > 0, 'should report updated hooks');

    const after = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest', 'SubagentStart', 'SubagentStop']) {
      const hook = after.hooks[event].find(g => g.hooks?.some(h => installer._isOwn(h.command)));
      const h = hook.hooks.find(h => installer._isOwn(h.command));
      assert.equal(h.async, true, `${event} should be async after upgrade`);
      assert.equal(h.timeout, 5, `${event} timeout should be 5 after upgrade`);
    }
  });

  await t.test('uninstall removes only own hooks', () => {
    const result = installer.uninstallClaudeHooks();
    assert.equal(result.removed, 7);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes('activity-monitor'));
    assert.equal(settings.hooks.PostToolUse, undefined);
  });

  await t.test('uninstall is idempotent', () => {
    const result = installer.uninstallClaudeHooks();
    assert.equal(result.removed, 0);
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('HookInstaller — Codex', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('uses project-level hooks.json path', () => {
    assert.equal(installer._codexPath(), path.join(tmpHome, '.codex', 'hooks.json'));
  });

  await t.test('install creates hook entries for all 6 Codex events (no SubagentStart/Stop)', () => {
    const result = installer.installCodexHooks();
    assert.equal(result.added, 6);
    assert.equal(result.total, 6);
    assert.equal(result.feature.enabled, true);
    assert.equal(result.feature.changed, true);
    assert.equal(result.trust.trusted, 6);

    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      assert.ok(config.hooks[event], `missing event ${event}`);
      assert.ok(config.hooks[event].length > 0);
    }
    assert.equal(config.hooks.SubagentStart, undefined, 'SubagentStart should not be installed for Codex');
    assert.equal(config.hooks.SubagentStop, undefined, 'SubagentStop should not be installed for Codex');

    const codexConfig = fs.readFileSync(installer._codexConfigPath(), 'utf8');
    assert.match(codexConfig, /^\[features\]$/m);
    assert.match(codexConfig, /^hooks = true$/m);
  });

  await t.test('idempotent — second install adds nothing', () => {
    const result = installer.installCodexHooks();
    assert.equal(result.added, 0);
    assert.equal(result.feature.changed, false);
    assert.equal(result.trust.trusted, 6);

    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      assert.equal(config.hooks[event].length, 1);
    }
  });

  await t.test('tool events have matcher, non-tool events do not', () => {
    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(config.hooks.PreToolUse[0].matcher, '');
    assert.equal(config.hooks.PostToolUse[0].matcher, '');
    assert.equal(config.hooks.UserPromptSubmit[0].matcher, undefined);
    assert.equal(config.hooks.Stop[0].matcher, undefined);
    assert.equal(config.hooks.PermissionRequest[0].matcher, undefined);
  });

  await t.test('hooks are registered as sync commands with type and short timeout', () => {
    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const hook = config.hooks[event][0].hooks[0];
      assert.equal(hook.type, 'command', `${event} hook should have type=command`);
      assert.equal(hook.async, undefined, `${event} hook should not set async because Codex skips async hooks`);
      assert.equal(hook.timeout, 5, `${event} hook timeout should be 5`);
    }
  });

  await t.test('Codex hook command includes explicit ZYLOS_RUNTIME and ZYLOS_DIR', () => {
    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    const cmd = config.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.includes('ZYLOS_RUNTIME=codex'), 'command should include ZYLOS_RUNTIME=codex');
    assert.ok(cmd.includes('ZYLOS_DIR='), 'command should include ZYLOS_DIR');
    assert.ok(cmd.includes('hook-ingest.cjs'), 'command should include hook-ingest.cjs');
  });

  await t.test('preserves existing hooks', () => {
    const existingHook = {
      hooks: [{ type: 'command', command: 'node ~/other-script.js', timeout: 1000 }],
      matcher: ''
    };
    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    config.hooks.PreToolUse.unshift(existingHook);
    fs.writeFileSync(installer._codexPath(), JSON.stringify(config, null, 2) + '\n');

    installer.installCodexHooks();

    const after = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(after.hooks.PreToolUse.length, 2);
    assert.ok(after.hooks.PreToolUse[0].hooks[0].command.includes('other-script'));
  });

  await t.test('removes async from existing hooks in-place', () => {
    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      if (!config.hooks[event]) continue;
      for (const group of config.hooks[event]) {
        for (const h of group.hooks || []) {
          if (installer._isOwn(h.command)) {
            h.timeout = 2000;
            h.async = true;
          }
        }
      }
    }
    fs.writeFileSync(installer._codexPath(), JSON.stringify(config, null, 2) + '\n');

    const result = installer.installCodexHooks();
    assert.ok(result.added > 0, 'should report updated hooks');

    const after = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const group = after.hooks[event].find(g => g.hooks?.some(h => installer._isOwn(h.command)));
      const h = group.hooks.find(h => installer._isOwn(h.command));
      assert.equal(h.async, undefined, `${event} should not set async after upgrade`);
      assert.equal(h.timeout, 5, `${event} timeout should be 5 after upgrade`);
    }
  });

  await t.test('uninstall removes only own hooks', () => {
    fs.mkdirSync(path.dirname(installer._codexConfigPath()), { recursive: true });
    fs.writeFileSync(installer._codexConfigPath(), `
[hooks.state."${installer._codexPath()}:pre_tool_use:0:0"]
enabled = true
trusted_hash = "sha256:same-path-other"

[hooks.state."${installer._codexPath()}:pre_tool_use:1:0"]
enabled = true
trusted_hash = "sha256:dashboard-pre"

[hooks.state."${installer._codexPath()}:stop:0:0"]
enabled = true
trusted_hash = "sha256:dashboard-stop"

[hooks.state."/tmp/other-hooks.json:pre_tool_use:0:0"]
enabled = true
trusted_hash = "sha256:other"
`);

    const result = installer.uninstallCodexHooks();
    assert.equal(result.removed, 6);
    assert.equal(result.trust.removed, 2);

    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(config.hooks.PreToolUse.length, 1);
    assert.ok(config.hooks.PreToolUse[0].hooks[0].command.includes('other-script'));
    assert.equal(config.hooks.PostToolUse, undefined);

    const codexConfig = fs.readFileSync(installer._codexConfigPath(), 'utf8');
    assert.match(codexConfig, new RegExp(`\\[hooks\\.state\\."${installer._codexPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:pre_tool_use:0:0"\\]`));
    assert.doesNotMatch(codexConfig, new RegExp(`\\[hooks\\.state\\."${installer._codexPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:pre_tool_use:1:0"\\]`));
    assert.doesNotMatch(codexConfig, new RegExp(`\\[hooks\\.state\\."${installer._codexPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:stop:0:0"\\]`));
    assert.match(codexConfig, /\[hooks\.state\."\/tmp\/other-hooks\.json:pre_tool_use:0:0"\]/);
  });

  await t.test('uninstall is idempotent', () => {
    const result = installer.uninstallCodexHooks();
    assert.equal(result.removed, 0);
    assert.equal(result.trust.removed, 0);
  });

  await t.test('enables existing false Codex hook feature flag in-place', () => {
    fs.mkdirSync(path.dirname(installer._codexConfigPath()), { recursive: true });
    fs.writeFileSync(installer._codexConfigPath(), '[features]\nhooks = false\n\n[projects."/tmp/example"]\ntrust_level = "trusted"\n');

    const result = installer.installCodexHooks();
    assert.equal(result.feature.changed, true);

    const codexConfig = fs.readFileSync(installer._codexConfigPath(), 'utf8');
    assert.match(codexConfig, /^hooks = true$/m);
    assert.doesNotMatch(codexConfig, /^hooks = false$/m);
    assert.match(codexConfig, /^\[projects\."\/tmp\/example"\]$/m);
  });

  await t.test('builds trust state only for dashboard hooks', () => {
    const state = installer._codexTrustStateFromHooksList([
      {
        hooks: [
          {
            key: '/tmp/hooks.json:pre_tool_use:0:0',
            command: `node ${installer.hookScript}`,
            currentHash: 'sha256:dashboard',
            isManaged: false
          },
          {
            key: '/tmp/hooks.json:post_tool_use:0:0',
            command: 'node ~/other-script.js',
            currentHash: 'sha256:other',
            isManaged: false
          },
          {
            key: '/tmp/hooks.json:stop:0:0',
            command: `node ${installer.hookScript}`,
            currentHash: 'sha256:managed',
            isManaged: true
          }
        ]
      }
    ]);

    assert.deepEqual(state, {
      '/tmp/hooks.json:pre_tool_use:0:0': {
        enabled: true,
        trusted_hash: 'sha256:dashboard'
      }
    });
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('HookInstaller — Codex flat-array migration', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('migrates old flat dashboard hooks to nested sync/timeout=5', () => {
    const oldFlat = [
      { event: 'PreToolUse', command: `node ${installer.hookScript}`, timeout: 2000 },
      { event: 'PostToolUse', command: `node ${installer.hookScript}`, timeout: 2000 },
      { event: 'UserPromptSubmit', command: `node ${installer.hookScript}`, timeout: 2000 },
      { event: 'Stop', command: `node ${installer.hookScript}`, timeout: 2000 },
      { event: 'PermissionRequest', command: `node ${installer.hookScript}`, timeout: 2000 }
    ];
    const p = installer._codexPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(oldFlat, null, 2) + '\n');

    const result = installer.installCodexHooks();
    assert.ok(result.added > 0, 'should upgrade migrated hooks');

    const config = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(!Array.isArray(config), 'file should be an object, not array');
    assert.ok(config.hooks, 'should have hooks key');

    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const group = config.hooks[event]?.find(g => g.hooks?.some(h => installer._isOwn(h.command)));
      assert.ok(group, `${event} should have a dashboard hook group`);
      const h = group.hooks.find(h => installer._isOwn(h.command));
      assert.equal(h.type, 'command', `${event} should have type=command`);
      assert.equal(h.async, undefined, `${event} should not set async after migration`);
      assert.equal(h.timeout, 5, `${event} timeout should be 5 after migration`);
    }
  });

  await t.test('preserves non-dashboard hooks during flat migration', () => {
    const oldFlat = [
      { event: 'PreToolUse', command: 'node ~/other-script.js', timeout: 1000 },
      { event: 'PreToolUse', command: `node ${installer.hookScript}`, timeout: 2000 },
      { event: 'Stop', command: `node ${installer.hookScript}`, timeout: 2000 }
    ];
    const p = installer._codexPath();
    fs.writeFileSync(p, JSON.stringify(oldFlat, null, 2) + '\n');

    installer.installCodexHooks();

    const config = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(config.hooks.PreToolUse.length, 2);
    assert.ok(config.hooks.PreToolUse.some(g =>
      g.hooks?.some(h => h.command.includes('other-script'))
    ), 'non-dashboard hook should be preserved');
  });

  await t.test('uninstall works on migrated file', () => {
    const result = installer.uninstallCodexHooks();
    assert.equal(result.removed, 6);

    const config = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(config.hooks.PreToolUse.length, 1);
    assert.ok(config.hooks.PreToolUse[0].hooks[0].command.includes('other-script'));
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('HookInstaller — detectRuntime', async (t) => {
  const installer = new HookInstaller('/tmp/fake');

  await t.test('defaults to claude when ZYLOS_RUNTIME unset', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    delete process.env.ZYLOS_RUNTIME;
    assert.equal(installer.detectRuntime(), 'claude');
    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
  });

  await t.test('returns codex when set', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    process.env.ZYLOS_RUNTIME = 'codex';
    assert.equal(installer.detectRuntime(), 'codex');
    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
    else delete process.env.ZYLOS_RUNTIME;
  });

  await t.test('returns null for unknown runtime', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    process.env.ZYLOS_RUNTIME = 'unknown';
    assert.equal(installer.detectRuntime(), null);
    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
    else delete process.env.ZYLOS_RUNTIME;
  });
});

test('HookInstaller — StatusLine', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('install creates statusLine entry', () => {
    const result = installer.installStatusline();
    assert.equal(result.installed, true);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(settings.statusLine.type, 'command');
    assert.ok(settings.statusLine.command.includes('statusline-ingest.cjs'));
    assert.equal(settings.statusLine.refreshInterval, 5);
  });

  await t.test('idempotent — second install skips', () => {
    const result = installer.installStatusline();
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'already_installed');
  });

  await t.test('does not overwrite existing non-dashboard statusline', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.statusLine = { type: 'command', command: 'node ~/my-statusline.js', refreshInterval: 10 };
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.installStatusline();
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'existing_statusline');
  });

  await t.test('uninstall removes own statusline only', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.statusLine = { type: 'command', command: `node ${installer.statuslineScript}`, refreshInterval: 5 };
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.uninstallStatusline();
    assert.equal(result.removed, true);

    const after = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(after.statusLine, undefined);
  });

  await t.test('uninstall does not remove non-dashboard statusline', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.statusLine = { type: 'command', command: 'node ~/other.js', refreshInterval: 10 };
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.uninstallStatusline();
    assert.equal(result.removed, false);
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('HookInstaller — install() provisions all supported runtimes', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();

  await t.test('installs Claude hooks, Codex hooks, and Claude statusline when runtime is claude', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    process.env.ZYLOS_RUNTIME = 'claude';

    const installer = makeInstaller(projectRoot, tmpHome);
    const result = installer.install();
    assert.equal(result.claude.runtime, 'claude');
    assert.equal(result.claude.added, 7);
    assert.equal(result.codex.runtime, 'codex');
    assert.equal(result.codex.added, 6);
    assert.equal(result.statusline.installed, true);

    const claudeSettings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    const codexSettings = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.ok(claudeSettings.hooks.PreToolUse);
    assert.ok(claudeSettings.hooks.UserPromptSubmit);
    assert.ok(claudeSettings.hooks.Stop);
    assert.ok(codexSettings.hooks.SessionStart);

    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
    else delete process.env.ZYLOS_RUNTIME;
  });

  await t.test('installs both hook sets even when runtime is codex', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    process.env.ZYLOS_RUNTIME = 'codex';

    const installer = makeInstaller(projectRoot, tmpHome);
    const result = installer.install();
    assert.equal(result.claude.runtime, 'claude');
    assert.equal(result.codex.runtime, 'codex');
    assert.equal(result.claude.added, 0);
    assert.equal(result.codex.added, 0);
    assert.equal(result.statusline.installed, false);
    assert.equal(result.statusline.reason, 'already_installed');

    const claudeSettings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    const codexSettings = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.ok(claudeSettings.hooks.PreToolUse);
    assert.ok(codexSettings.hooks.UserPromptSubmit);

    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
    else delete process.env.ZYLOS_RUNTIME;
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// Regression for #147: an agent upgraded from the version that migrated
// UserPromptSubmit/Stop to JSONL has those two hooks already stripped from its
// settings.json. install() on the fixed version must re-add exactly those two
// (self-heal) without duplicating the surviving hooks.
test('HookInstaller — install() self-heals an already-stripped deployment (#147)', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('re-adds UserPromptSubmit + Stop, leaves surviving hooks untouched', () => {
    const ownHook = () => ({
      hooks: [{ type: 'command', command: `node ${installer.hookScript}`, timeout: 5, async: true }]
    });
    // Settings as left by the migrated (buggy) version: 5 own hooks, the two
    // turn hooks gone.
    const stripped = {
      hooks: {
        PreToolUse: [{ ...ownHook(), matcher: '' }],
        PostToolUse: [{ ...ownHook(), matcher: '' }],
        PermissionRequest: [ownHook()],
        SubagentStart: [ownHook()],
        SubagentStop: [ownHook()]
      }
    };
    fs.mkdirSync(path.dirname(installer._claudePath()), { recursive: true });
    fs.writeFileSync(installer._claudePath(), JSON.stringify(stripped, null, 2) + '\n');

    const result = installer.install();
    assert.equal(result.claude.added, 2, 'only the two missing turn hooks are added');

    const after = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.ok(after.hooks.UserPromptSubmit?.length, 'UserPromptSubmit restored');
    assert.ok(after.hooks.Stop?.length, 'Stop restored');
    // Surviving hooks are not duplicated.
    for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop']) {
      assert.equal(after.hooks[event].length, 1, `${event} not duplicated`);
    }
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});
