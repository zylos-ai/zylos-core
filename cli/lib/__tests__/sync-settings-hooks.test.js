import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const {
  CORE_MANAGED_HOOKS,
  isCoreManaged,
  persistInstalledSettingsAndSyncCoupledThreshold,
  shouldSyncCodexConfig,
  syncCodexConfig,
  syncHooks,
  syncModelCoupledNewSessionThreshold,
  syncTemplateSetting,
  syncTemplateModelSetting,
} = await import('../sync-settings-hooks.js');
const { extractScriptPath, getCommandHooks, hookScriptKey } = await import('../hook-utils.js');
const {
  renderCodexGlobalConfig,
  renderCodexProjectConfig,
} = await import('../runtime-setup.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_SETTINGS_PATH = path.join(__dirname, '..', '..', '..', 'templates', '.claude', 'settings.json');
const CONTEXT_MONITOR_PATH = path.join(__dirname, '..', '..', '..', 'skills', 'activity-monitor', 'scripts', 'context-monitor.js');

function fixtureZylosDir() {
  return path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
}

function zylosHookPath(relativePath) {
  return path.join(fixtureZylosDir(), '.claude', relativePath).replaceAll('\\', '/');
}

describe('Claude settings template', () => {
  it('defaults fresh installs to Opus with 1M context (opus[1m])', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    assert.equal(template.model, 'opus[1m]');
  });

  it('disables autoMemoryEnabled and autoDreamEnabled by default', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    assert.equal(template.autoMemoryEnabled, false);
    assert.equal(template.autoDreamEnabled, false);
  });

  it('uses the SessionStart orchestrator for all SessionStart matchers', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    const groups = template.hooks.SessionStart;
    assert.equal(groups.length, 3);
    for (const group of groups) {
      const commands = group.hooks.map(h => h.command);
      assert.equal(group.hooks.length, 1);
      assert.ok(commands.some(cmd => cmd.includes('session-start-orchestrator.js')));
      assert.equal(group.hooks[0].timeout, 20000);
    }
  });

  it('includes PostToolUseFailure activity hook', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    const groups = template.hooks.PostToolUseFailure || [];
    assert.equal(groups.length, 1);
    assert.ok(groups[0].hooks.some(h => h.command.includes('hook-activity.js')));
  });
});

describe('Activity monitor threshold fallback', () => {
  it('keeps the runtime fallback threshold at 70', () => {
    const source = fs.readFileSync(CONTEXT_MONITOR_PATH, 'utf8');
    assert.match(source, /const DEFAULT_THRESHOLD = 70;/);
  });
});

describe('syncTemplateModelSetting', () => {
  it('backfills the template model when the installed settings omit model', () => {
    const installedSettings = {};
    const logs = [];

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'claude-opus-4-6' },
      installedSettings,
      cfg: {},
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.equal(installedSettings.model, 'claude-opus-4-6');
    assert.deepEqual(logs, ['  + model: claude-opus-4-6']);
  });

  it('preserves an existing user-configured model', () => {
    const installedSettings = { model: 'sonnet' };

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'opus' },
      installedSettings,
      cfg: {},
      log: () => {
        throw new Error('should not log when model already exists');
      },
    });

    assert.equal(result.changed, false);
    assert.equal(installedSettings.model, 'sonnet');
  });

  it('downgrades opus[1m] to opus when threshold is above 30', () => {
    const installedSettings = {};
    const logs = [];

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'opus[1m]' },
      installedSettings,
      cfg: { new_session_threshold: 70 },
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.equal(installedSettings.model, 'opus');
    assert.equal(result.model, 'opus');
  });

  it('keeps opus[1m] when threshold is not set', () => {
    const installedSettings = {};
    const logs = [];

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'opus[1m]' },
      installedSettings,
      cfg: {},
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.equal(installedSettings.model, 'opus[1m]');
  });

  it('keeps opus[1m] when threshold is at or below 30', () => {
    const installedSettings = {};
    const logs = [];

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'opus[1m]' },
      installedSettings,
      cfg: { new_session_threshold: 30 },
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.equal(installedSettings.model, 'opus[1m]');
  });

  it('does not guard non-1m models regardless of threshold', () => {
    const installedSettings = {};
    const logs = [];

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'opus' },
      installedSettings,
      cfg: { new_session_threshold: 70 },
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.equal(installedSettings.model, 'opus');
  });
});

describe('syncModelCoupledNewSessionThreshold', () => {
  it('writes threshold 30 when model was backfilled and threshold is missing', () => {
    const updates = [];
    const logs = [];

    const result = syncModelCoupledNewSessionThreshold({
      modelBackfilled: true,
      cfg: {},
      updateConfig: (update) => updates.push(update),
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.deepEqual(updates, [{ new_session_threshold: 30 }]);
    assert.deepEqual(logs, ['  + new_session_threshold: 30 (paired with model backfill)']);
  });

  it('preserves an explicit threshold when model was backfilled', () => {
    const result = syncModelCoupledNewSessionThreshold({
      modelBackfilled: true,
      cfg: { new_session_threshold: 70 },
      updateConfig: () => {
        throw new Error('should not overwrite explicit threshold');
      },
      log: () => {
        throw new Error('should not log when threshold exists');
      },
    });

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'threshold_already_set');
  });

  it('does not write threshold when model was not backfilled', () => {
    const result = syncModelCoupledNewSessionThreshold({
      modelBackfilled: false,
      cfg: {},
      updateConfig: () => {
        throw new Error('should not write threshold without model backfill');
      },
      log: () => {
        throw new Error('should not log without model backfill');
      },
    });

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'model_not_backfilled');
  });

  it('supports dry run without writing config', () => {
    const logs = [];
    const result = syncModelCoupledNewSessionThreshold({
      modelBackfilled: true,
      cfg: {},
      dryRun: true,
      updateConfig: () => {
        throw new Error('dry run should not write config');
      },
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.deepEqual(logs, ['  + new_session_threshold: 30 (paired with model backfill)']);
  });
});

describe('persistInstalledSettingsAndSyncCoupledThreshold', () => {
  const normalizeBackupPath = (filePath) => filePath.replace(/\.bak\.\d+$/, '.bak.<ts>');

  it('writes settings before syncing the paired threshold', () => {
    const calls = [];
    const result = persistInstalledSettingsAndSyncCoupledThreshold({
      installedSettings: { model: 'opus[1m]' },
      settingsPath: '/tmp/zylos/.claude/settings.json',
      modelBackfilled: true,
      mkdirSync: (dir, opts) => calls.push(['mkdir', dir, opts]),
      writeFileSync: (filePath, content) => calls.push(['writeSettings', filePath, JSON.parse(content)]),
      syncThreshold: ({ modelBackfilled }) => {
        calls.push(['syncThreshold', modelBackfilled]);
        return { changed: true };
      },
    });

    assert.equal(result.changed, true);
    assert.deepEqual(calls, [
      ['mkdir', '/tmp/zylos/.claude', { recursive: true }],
      ['writeSettings', '/tmp/zylos/.claude/settings.json', { model: 'opus[1m]' }],
      ['syncThreshold', true],
    ]);
  });

  it('backs up existing settings before writing', () => {
    const calls = [];
    persistInstalledSettingsAndSyncCoupledThreshold({
      installedSettings: { hooks: {} },
      settingsPath: '/tmp/zylos/.claude/settings.json',
      mkdirSync: (dir, opts) => calls.push(['mkdir', dir, opts]),
      existsSync: () => true,
      copyFileSync: (from, to) => calls.push(['copy', normalizeBackupPath(from), normalizeBackupPath(to)]),
      writeFileSync: (filePath, content) => calls.push(['writeSettings', filePath, JSON.parse(content)]),
      syncThreshold: () => ({ changed: false }),
    });

    assert.deepEqual(calls, [
      ['mkdir', '/tmp/zylos/.claude', { recursive: true }],
      ['copy', '/tmp/zylos/.claude/settings.json', '/tmp/zylos/.claude/settings.json.bak.<ts>'],
      ['writeSettings', '/tmp/zylos/.claude/settings.json', { hooks: {} }],
    ]);
  });

  it('prunes old .bak backups after a successful write, keeping the newest N', () => {
    const unlinked = [];
    persistInstalledSettingsAndSyncCoupledThreshold({
      installedSettings: { hooks: {} },
      settingsPath: '/tmp/zylos/.claude/settings.json',
      maxBackups: 3,
      mkdirSync: () => {},
      existsSync: () => true,
      copyFileSync: () => {},
      writeFileSync: () => {},
      readdirSync: () => [
        'settings.json',
        'settings.json.bak.100',
        'settings.json.bak.500',
        'settings.json.bak.300',
        'settings.json.bak.200',
        'settings.json.bak.400',
        'other.json.bak.999',
      ],
      unlinkSync: (p) => unlinked.push(p),
      syncThreshold: () => ({ changed: false }),
    });

    // newest 3 (500,400,300) kept; oldest 2 (200,100) removed; unrelated file untouched
    assert.deepEqual(unlinked.sort(), [
      '/tmp/zylos/.claude/settings.json.bak.100',
      '/tmp/zylos/.claude/settings.json.bak.200',
    ]);
  });

  it('does not fail the write when backup pruning throws', () => {
    assert.doesNotThrow(() => persistInstalledSettingsAndSyncCoupledThreshold({
      installedSettings: { hooks: {} },
      settingsPath: '/tmp/zylos/.claude/settings.json',
      mkdirSync: () => {},
      existsSync: () => true,
      copyFileSync: () => {},
      writeFileSync: () => {},
      readdirSync: () => { throw new Error('ENOENT'); },
      syncThreshold: () => ({ changed: false }),
    }));
  });

  it('restores the backup when writing settings fails', () => {
    const calls = [];
    assert.throws(() => persistInstalledSettingsAndSyncCoupledThreshold({
      installedSettings: { hooks: {} },
      settingsPath: '/tmp/zylos/.claude/settings.json',
      mkdirSync: () => {},
      existsSync: () => true,
      copyFileSync: (from, to) => calls.push(['copy', normalizeBackupPath(from), normalizeBackupPath(to)]),
      writeFileSync: () => { throw new Error('disk full'); },
      syncThreshold: () => { throw new Error('should not sync threshold after failed write'); },
    }), /disk full/);

    assert.deepEqual(calls, [
      ['copy', '/tmp/zylos/.claude/settings.json', '/tmp/zylos/.claude/settings.json.bak.<ts>'],
      ['copy', '/tmp/zylos/.claude/settings.json.bak.<ts>', '/tmp/zylos/.claude/settings.json'],
    ]);
  });
});

describe('syncTemplateSetting', () => {
  it('backfills a missing setting from template', () => {
    const installedSettings = {};
    const logs = [];

    const result = syncTemplateSetting('autoMemoryEnabled', {
      templateSettings: { autoMemoryEnabled: false },
      installedSettings,
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.equal(installedSettings.autoMemoryEnabled, false);
    assert.deepEqual(logs, ['  + autoMemoryEnabled: false']);
  });

  it('preserves an existing user-configured setting', () => {
    const installedSettings = { autoDreamEnabled: true };

    const result = syncTemplateSetting('autoDreamEnabled', {
      templateSettings: { autoDreamEnabled: false },
      installedSettings,
      log: () => { throw new Error('should not log'); },
    });

    assert.equal(result.changed, false);
    assert.equal(installedSettings.autoDreamEnabled, true);
  });

  it('skips when template does not have the key', () => {
    const installedSettings = {};

    const result = syncTemplateSetting('nonExistent', {
      templateSettings: {},
      installedSettings,
      log: () => { throw new Error('should not log'); },
    });

    assert.equal(result.changed, false);
  });
});

describe('shouldSyncCodexConfig', () => {
  it('skips when runtime is not codex and no codex state exists', () => {
    const result = shouldSyncCodexConfig({
      cfg: { runtime: 'claude' },
      homeDir: '/tmp/no-codex',
      existsSync: () => false,
    });

    assert.equal(result.shouldSync, false);
  });
});

describe('syncCodexConfig', () => {
  it('refreshes stale codex config when codex state exists outside codex runtime', () => {
    const writes = [];
    const logs = [];
    const globalConfigPath = '/tmp/home/.codex/config.toml';

    const result = syncCodexConfig({
      cfg: { runtime: 'claude' },
      homeDir: '/tmp/home',
      projectDir: '/tmp/zylos',
      existsSync: (filePath) => filePath === globalConfigPath,
      // Return stale content so drift is detected
      readFileSync: () => 'stale-content\n',
      writeConfig: (projectDir) => {
        writes.push(projectDir);
        return true;
      },
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.deepEqual(writes, ['/tmp/zylos']);
    assert.ok(logs.some(line => line.includes('codex')));
  });

  it('treats refresh failures as fatal only in codex runtime', () => {
    const result = syncCodexConfig({
      cfg: { runtime: 'codex' },
      homeDir: '/tmp/home',
      projectDir: '/tmp/zylos',
      existsSync: () => true,
      // Return stale content so drift is detected
      readFileSync: () => 'stale-content\n',
      writeConfig: () => false,
      log: () => {},
    });

    assert.equal(result.fatal, true);
    assert.match(result.error, /Failed to refresh/);
  });

  it('is idempotent after refreshing configs with external keys', () => {
    const homeDir = '/tmp/home';
    const projectDir = '/tmp/zylos';
    const globalConfigPath = path.join(homeDir, '.codex', 'config.toml');
    const projectConfigPath = path.join(projectDir, '.codex', 'config.toml');
    const files = new Map([
      [globalConfigPath, [
        'model_reasoning_effort = "medium"',
        '',
        '[profile.fast]',
        'model = "gpt-5.4-mini"',
        '',
      ].join('\n')],
      [projectConfigPath, [
        'user_added = "keep"',
        '',
        '[features]',
        'fast_mode = false',
        '',
      ].join('\n')],
    ]);

    const syncOnce = () => syncCodexConfig({
      cfg: { runtime: 'codex' },
      homeDir,
      projectDir,
      existsSync: (filePath) => files.has(filePath),
      readFileSync: (filePath) => files.get(filePath),
      writeConfig: () => {
        files.set(projectConfigPath, renderCodexProjectConfig(files.get(projectConfigPath)));
        files.set(globalConfigPath, renderCodexGlobalConfig(projectDir, files.get(globalConfigPath)));
        return true;
      },
      log: () => {},
    });

    const first = syncOnce();
    const second = syncOnce();

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.match(files.get(projectConfigPath), /user_added = "keep"/);
    assert.match(files.get(projectConfigPath), /\[features\][\s\S]*fast_mode = false[\s\S]*multi_agent = true[\s\S]*hooks = true/);
    assert.match(files.get(globalConfigPath), /\[features\][\s\S]*hooks = true/);
    assert.match(files.get(globalConfigPath), /model_reasoning_effort = "medium"/);
    assert.match(files.get(globalConfigPath), /\[profile\.fast\]/);
  });

  it('detects real drift in zylos-managed project keys', () => {
    const homeDir = '/tmp/home';
    const projectDir = '/tmp/zylos';
    const globalConfigPath = path.join(homeDir, '.codex', 'config.toml');
    const projectConfigPath = path.join(projectDir, '.codex', 'config.toml');
    const files = new Map([
      [globalConfigPath, renderCodexGlobalConfig(projectDir, '')],
      [projectConfigPath, renderCodexProjectConfig('').replace(
        'check_for_update_on_startup = false',
        'check_for_update_on_startup = true'
      )],
    ]);
    const logs = [];

    const result = syncCodexConfig({
      cfg: { runtime: 'codex' },
      homeDir,
      projectDir,
      existsSync: (filePath) => files.has(filePath),
      readFileSync: (filePath) => files.get(filePath),
      writeConfig: () => true,
      log: (line) => logs.push(line),
      dryRun: true,
    });

    assert.equal(result.changed, true);
    assert.ok(logs.some((line) => line.includes('codex project config')));
  });
});

// --- Helpers ---
function makeHook(scriptPath, timeout = 10000) {
  return { type: 'command', command: `node ${scriptPath}`, timeout };
}

function makeMatcherGroup(matcher, scriptPaths) {
  return {
    matcher,
    hooks: scriptPaths.map(p => makeHook(p)),
  };
}

function makeStandardOldSessionStartGroup(matcher) {
  return {
    matcher,
    hooks: [
      makeHook(zylosHookPath('skills/zylos-memory/scripts/session-start-inject.js'), 10000),
      makeHook(zylosHookPath('skills/comm-bridge/scripts/c4-session-init.js'), 10000),
      makeHook(zylosHookPath('skills/activity-monitor/scripts/session-foreground.js'), 5000),
      makeHook(zylosHookPath('skills/activity-monitor/scripts/session-start-prompt.js'), 5000),
    ],
  };
}

function makeDriftedOldSessionStartGroup(matcher) {
  const group = makeStandardOldSessionStartGroup(matcher);
  return {
    matcher,
    hooks: [
      group.hooks[0],
      group.hooks[1],
      group.hooks[3],
      group.hooks[2],
    ],
  };
}

function makeOrchestratorTemplate() {
  return {
    hooks: {
      SessionStart: ['startup', 'clear', 'compact'].map(matcher => ({
        matcher,
        hooks: [
          makeHook(zylosHookPath('skills/activity-monitor/scripts/session-start-orchestrator.js'), 20000),
        ],
      })),
    },
  };
}

function assertSessionStartUsesOrchestrator(settings) {
  assert.equal(settings.hooks.SessionStart.length, 3);
  for (const group of settings.hooks.SessionStart) {
    assert.equal(group.hooks.length, 1);
    assert.match(group.hooks[0].command, /session-start-orchestrator\.js/);
    assert.equal(group.hooks[0].timeout, 20000);
  }
}

describe('extractScriptPath', () => {
  it('takes the interpreter script argument instead of later path-like arguments', () => {
    assert.equal(extractScriptPath('node x.js /tmp/y.js'), 'x.js');
  });

  it('uses the last shell segment so source prefixes do not win', () => {
    assert.equal(
      extractScriptPath('source ~/.nvm/nvm.sh && node ~/zylos/.claude/skills/a/scripts/b.js'),
      path.join(os.homedir(), 'zylos/.claude/skills/a/scripts/b.js')
    );
  });

  it('skips interpreter flags before the script argument', () => {
    assert.equal(
      extractScriptPath('node --trace-warnings ~/zylos/.claude/skills/a/scripts/b.js --mode startup'),
      path.join(os.homedir(), 'zylos/.claude/skills/a/scripts/b.js')
    );
  });

  it('keeps quoted paths with spaces as one script argument', () => {
    const scriptPath = zylosHookPath('skills/a dir/scripts/b.js');
    assert.equal(
      extractScriptPath(`node "${scriptPath}" /tmp/y.js`),
      scriptPath
    );
  });
});

describe('hookScriptKey', () => {
  it('normalizes absolute, home-relative, and backslash zylos-root script paths to the same registry key', () => {
    assert.equal(
      hookScriptKey('node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js'),
      'skills/activity-monitor/scripts/session-start-orchestrator.js'
    );
    assert.equal(
      hookScriptKey(`node ${zylosHookPath('skills/activity-monitor/scripts/session-start-orchestrator.js')}`),
      'skills/activity-monitor/scripts/session-start-orchestrator.js'
    );
    assert.equal(
      hookScriptKey(`node ${zylosHookPath('skills/activity-monitor/scripts/session-start-orchestrator.js').replaceAll('/', '\\')}`),
      'skills/activity-monitor/scripts/session-start-orchestrator.js'
    );
  });

  it('keeps paths outside the zylos .claude root as full normalized paths even when suffixes collide', () => {
    assert.equal(
      hookScriptKey('node /opt/custom/skills/activity-monitor/scripts/session-start-orchestrator.js --mine'),
      '/opt/custom/skills/activity-monitor/scripts/session-start-orchestrator.js'
    );
    assert.equal(
      hookScriptKey('node /opt/custom/skills/zylos-memory/scripts/session-start-inject.js'),
      '/opt/custom/skills/zylos-memory/scripts/session-start-inject.js'
    );
    assert.equal(
      hookScriptKey('node ~/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js'),
      `${os.homedir()}/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js`
    );
    assert.equal(
      isCoreManaged({ type: 'command', command: 'node ~/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js' }),
      false
    );
  });

  it('resolves relative ZYLOS_DIR before checking the zylos .claude root', () => {
    const previousZylosDir = process.env.ZYLOS_DIR;
    process.env.ZYLOS_DIR = 'relative-zylos';
    try {
      const absoluteCoreHook = path.resolve(
        'relative-zylos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js'
      );
      assert.equal(
        hookScriptKey(`node ${absoluteCoreHook}`),
        'skills/activity-monitor/scripts/session-start-orchestrator.js'
      );
      assert.equal(
        isCoreManaged({ type: 'command', command: `node ${absoluteCoreHook}` }),
        true
      );
    } finally {
      if (previousZylosDir === undefined) {
        delete process.env.ZYLOS_DIR;
      } else {
        process.env.ZYLOS_DIR = previousZylosDir;
      }
    }
  });
});

describe('core hook registry', () => {
  it('includes every command hook in the settings template', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    const templateKeys = new Set();

    for (const groups of Object.values(template.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const hook of getCommandHooks(group)) {
          templateKeys.add(hookScriptKey(hook.command));
        }
      }
    }

    for (const key of templateKeys) {
      assert.equal(CORE_MANAGED_HOOKS.has(key), true, `${key} missing from CORE_MANAGED_HOOKS`);
    }
  });
});

describe('syncHooks SessionStart orchestrator convergence', () => {
  const noopLog = () => {};

  it('converges standard old SessionStart groups through generic sync', () => {
    const installed = {
      hooks: {
        SessionStart: ['startup', 'clear', 'compact'].map(makeStandardOldSessionStartGroup),
      },
    };

    const result = syncHooks(installed, makeOrchestratorTemplate(), { log: noopLog });

    assert.deepEqual(result, { added: 3, updated: 0, removed: 12 });
    assertSessionStartUsesOrchestrator(installed);
  });

  it('converges order-drifted old SessionStart groups', () => {
    const installed = {
      hooks: {
        SessionStart: ['startup', 'clear', 'compact'].map(makeDriftedOldSessionStartGroup),
      },
    };

    syncHooks(installed, makeOrchestratorTemplate(), { log: noopLog });

    assertSessionStartUsesOrchestrator(installed);
  });

  it('converges timeout-drifted and partial old SessionStart groups', () => {
    const installed = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              makeHook(zylosHookPath('skills/zylos-memory/scripts/session-start-inject.js'), 9000),
              makeHook(zylosHookPath('skills/comm-bridge/scripts/c4-session-init.js'), 10000),
              makeHook(zylosHookPath('skills/activity-monitor/scripts/session-start-prompt.js'), 5000),
            ],
          },
          makeStandardOldSessionStartGroup('clear'),
          makeStandardOldSessionStartGroup('compact'),
        ],
      },
    };

    syncHooks(installed, makeOrchestratorTemplate(), { log: noopLog });

    assertSessionStartUsesOrchestrator(installed);
  });

  it('converges old catch-all SessionStart group to specific orchestrator matchers', () => {
    const installed = {
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: makeStandardOldSessionStartGroup('').hooks,
          },
        ],
      },
    };

    syncHooks(installed, makeOrchestratorTemplate(), { log: noopLog });

    assertSessionStartUsesOrchestrator(installed);
    assert.equal(installed.hooks.SessionStart.some(group => group.matcher === ''), false);
  });

  it('preserves user command hooks and non-command hooks while removing retired core hooks', () => {
    const installed = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              ...makeStandardOldSessionStartGroup('startup').hooks,
              makeHook('/custom/my-session-start.js', 5000),
              { type: 'prompt', prompt: 'keep me' },
            ],
          },
        ],
      },
    };

    syncHooks(installed, makeOrchestratorTemplate(), { log: noopLog });

    const startup = installed.hooks.SessionStart.find(group => group.matcher === 'startup');
    assert.ok(startup.hooks.some(h => h.command?.includes('session-start-orchestrator.js')));
    assert.ok(startup.hooks.some(h => h.command?.includes('/custom/my-session-start.js')));
    assert.ok(startup.hooks.some(h => h.type === 'prompt'));
    assert.equal(startup.hooks.some(h => h.command?.includes('session-start-inject.js')), false);
  });

  it('does not claim user hooks outside the zylos .claude root whose suffix collides with current or retired registry keys', () => {
    const installed = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              makeHook('/opt/custom/skills/activity-monitor/scripts/session-start-orchestrator.js --mine', 9000),
              makeHook('/opt/custom/skills/zylos-memory/scripts/session-start-inject.js', 7000),
              { type: 'command', command: 'node ~/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js --foreign', timeout: 6000 },
            ],
          },
        ],
      },
    };

    const result = syncHooks(installed, makeOrchestratorTemplate(), { log: noopLog });

    const startup = installed.hooks.SessionStart.find(group => group.matcher === 'startup');
    assert.equal(result.updated, 0);
    assert.equal(result.removed, 0);
    assert.ok(startup.hooks.some(h =>
      h.command === 'node /opt/custom/skills/activity-monitor/scripts/session-start-orchestrator.js --mine' &&
      h.timeout === 9000
    ));
    assert.ok(startup.hooks.some(h =>
      h.command === 'node /opt/custom/skills/zylos-memory/scripts/session-start-inject.js' &&
      h.timeout === 7000
    ));
    assert.ok(startup.hooks.some(h =>
      h.command === 'node ~/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js --foreign' &&
      h.timeout === 6000
    ));
  });

  it('is idempotent when installed hooks already match the template', () => {
    const installed = JSON.parse(JSON.stringify(makeOrchestratorTemplate()));

    const result = syncHooks(installed, makeOrchestratorTemplate(), { log: noopLog });

    assert.deepEqual(result, { added: 0, updated: 0, removed: 0 });
    assertSessionStartUsesOrchestrator(installed);
  });
});

// --- syncHooks (forward + reverse pass) tests ---
describe('syncHooks forward pass', () => {
  const noopLog = () => {};

  it('adds missing template hooks to existing matcher groups while preserving user hooks', () => {
    const installed = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js', timeout: 10000 },
            { type: 'command', command: 'node ~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js', timeout: 10000 },
            { type: 'command', command: 'node /custom/user-hook.js', timeout: 5000 },
          ]},
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
            '~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js',
          ]),
          makeMatcherGroup('clear', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
            '~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js',
          ]),
          makeMatcherGroup('compact', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
            '~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js',
          ]),
        ],
      },
    };

    const result = syncHooks(installed, template, { log: noopLog });

    const startupGroup = installed.hooks.SessionStart.find(g => g.matcher === 'startup');
    assert.equal(startupGroup.hooks.length, 4);
    assert.ok(startupGroup.hooks.some(h => h.command.includes('session-start-prompt.js')));
    assert.ok(startupGroup.hooks.some(h => h.command.includes('/custom/user-hook.js')));

    // clear and compact should be added
    assert.equal(installed.hooks.SessionStart.length, 3);
    const clearGroup = installed.hooks.SessionStart.find(g => g.matcher === 'clear');
    const compactGroup = installed.hooks.SessionStart.find(g => g.matcher === 'compact');
    assert.ok(clearGroup);
    assert.ok(compactGroup);
    assert.equal(clearGroup.hooks.length, 3);
    assert.equal(compactGroup.hooks.length, 3);
    assert.equal(result.added, 7);
  });

  it('registers ToolWatchdog activity hooks during upgrade when event matcher groups already exist', () => {
    const installed = {
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [
            { type: 'command', command: 'node /custom/pre-tool.js', timeout: 5000 },
          ]},
        ],
        PostToolUse: [
          { matcher: '', hooks: [
            { type: 'command', command: 'node /custom/post-tool.js', timeout: 5000 },
          ]},
        ],
        PostToolUseFailure: [
          { matcher: '', hooks: [
            { type: 'command', command: 'node /custom/post-tool-failure.js', timeout: 5000 },
          ]},
        ],
        Stop: [
          { hooks: [
            { type: 'command', command: 'node /custom/stop.js', timeout: 5000 },
          ]},
        ],
      },
    };
    const template = {
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js', async: true, timeout: 5 },
          ]},
        ],
        PostToolUse: [
          { matcher: '', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js', async: true, timeout: 5 },
          ]},
        ],
        PostToolUseFailure: [
          { matcher: '', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js', async: true, timeout: 5 },
          ]},
        ],
        Stop: [
          { hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js', async: true, timeout: 5 },
          ]},
        ],
      },
    };

    const result = syncHooks(installed, template, { log: noopLog });

    assert.equal(result.added, 4);
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
      const group = installed.hooks[event][0];
      assert.ok(group.hooks.some(h => h.command.includes('hook-activity.js')));
      assert.ok(group.hooks.some(h => h.command.includes('/custom/')));
    }
  });

  it('adds missing matcher groups from template', () => {
    const installed = { hooks: {} };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    const result = syncHooks(installed, template, { log: noopLog });

    assert.equal(result.added, 2);
    assert.equal(installed.hooks.SessionStart.length, 2);
  });

  it('updates command/timeout drift in existing matcher group', () => {
    const installed = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/a/scripts/a.js', timeout: 5000 },
          ]},
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/a/scripts/a.js', timeout: 10000 },
          ]},
        ],
      },
    };

    const result = syncHooks(installed, template, { log: noopLog });

    assert.equal(result.updated, 1);
    assert.equal(installed.hooks.SessionStart[0].hooks[0].timeout, 10000);
  });

  it('handles the full migration scenario: catch-all → specific matchers', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
            '~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js',
          ]),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
            '~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js',
          ]),
          makeMatcherGroup('clear', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
            '~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js',
          ]),
          makeMatcherGroup('compact', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
            '~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js',
          ]),
        ],
      },
    };

    syncHooks(installed, template, { log: noopLog });

    assert.equal(installed.hooks.SessionStart.length, 3);
    const matchers = installed.hooks.SessionStart.map(g => g.matcher).sort();
    assert.deepEqual(matchers, ['clear', 'compact', 'startup']);
    for (const group of installed.hooks.SessionStart) {
      assert.equal(group.hooks.length, 3);
    }
  });

  it('reverse pass removes obsolete core hooks', () => {
    const installed = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/old-skill/scripts/old.js', timeout: 5000 },
          ]},
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [],
      },
    };

    const result = syncHooks(installed, template, { log: noopLog });

    // old-skill is not a core skill (not in template), so it's preserved
    assert.equal(result.removed, 0);
  });

  it('reverse pass preserves user hooks not in template', () => {
    const installed = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [
            { type: 'command', command: 'node /custom/my-hook.js', timeout: 5000 },
          ]},
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['~/zylos/.claude/skills/a/scripts/a.js']),
        ],
      },
    };

    syncHooks(installed, template, { log: noopLog });

    // User's custom hook should still be there, and the missing template hook
    // should be registered in the same matcher group.
    const startupGroup = installed.hooks.SessionStart.find(g => g.matcher === 'startup');
    assert.equal(startupGroup.hooks.length, 2);
    assert.ok(startupGroup.hooks.some(h => h.command.includes('my-hook.js')));
    assert.ok(startupGroup.hooks.some(h => h.command.includes('/skills/a/scripts/a.js')));
  });

  it('reverse pass removes core hook from one matcher when template removes it (matcher-aware)', () => {
    // Hook exists in both startup and clear in installed config
    // Template keeps it in startup but removes it from clear
    const installed = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js', timeout: 5000 },
          ]},
          { matcher: 'clear', hooks: [
            { type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js', timeout: 5000 },
          ]},
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js']),
          makeMatcherGroup('clear', []),  // removed from clear
        ],
      },
    };

    const result = syncHooks(installed, template, { log: noopLog });

    assert.equal(result.removed, 1);
    // startup should still have the hook
    const startupGroup = installed.hooks.SessionStart.find(g => g.matcher === 'startup');
    assert.equal(startupGroup.hooks.length, 1);
    // clear group should be cleaned up (empty after removal)
    const clearGroup = installed.hooks.SessionStart.find(g => g.matcher === 'clear');
    assert.equal(clearGroup, undefined); // empty group gets removed
  });
});
