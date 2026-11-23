import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writePaneProcess } from '../runtime/pane-process.js';
import { readProcessStart } from '../../../skills/activity-monitor/scripts/claude-pid.js';

const {
  desiredClaudeHooks,
  persistInstalledSettingsAndSyncCoupledThreshold,
  syncHooks,
  syncTemplateSetting,
} = await import('../runtime/claude/hooks.js');
const { hookScriptBaseKey, extractShardArg } = await import('../hook-utils.js');
const {
  syncCodexConfig, codexHooksPath, installCoreCodexHook,
  renderCodexGlobalConfig,
  renderCodexProjectConfig,
} = await import('../runtime/codex/hooks.js');
const { activateFreshSplitInstructions, instructionPaths } = await import('../runtime/instruction-builder.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INIT_MODULE_PATH = path.join(__dirname, '..', '..', 'commands', 'init.js');

function fixtureZylosDir() {
  return path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
}

function zylosHookPath(relativePath) {
  return path.join(fixtureZylosDir(), '.claude', relativePath).replaceAll('\\', '/');
}

const CORE_SHARD_SEQUENCE = [
  'identity',
  'custom',
  'references',
  'c4-conversations',
  'onboarding',
  'fg',
  'start-prompt',
];

describe('desiredClaudeHooks', () => {

  it('fresh init deploy syncs exactly one assembler hook for startup, clear, and compact', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-init-hooks-'));
    const zylosDir = path.join(homeDir, 'zylos');
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude' }));
    const controlPath = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
    const restartLog = path.join(homeDir, 'restart.jsonl');
    fs.mkdirSync(path.dirname(controlPath), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(controlPath), 'package.json'), '{"type":"module"}');
    fs.writeFileSync(controlPath, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(restartLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
    execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { deployTemplates } from ${JSON.stringify(INIT_MODULE_PATH)}; await deployTemplates({ freshInstall: true });`,
    ], {
      stdio: 'pipe',
      env: { ...process.env, HOME: homeDir, ZYLOS_DIR: zylosDir },
    });
    const settings = JSON.parse(fs.readFileSync(path.join(zylosDir, '.claude', 'settings.json'), 'utf8'));
    for (const matcher of ['startup', 'clear', 'compact']) {
      const groups = settings.hooks.SessionStart.filter(group => group.matcher === matcher);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].hooks.filter(hook => hook.command.includes('assembler.mjs')).length, 1);
    }
    assert.equal(fs.existsSync(restartLog), false, 'fresh init must never enqueue a restart');
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('the real clear hook rebuilds changed user instructions in a sandbox', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-clear-hook-smoke-'));
    const templatesDir = path.join(__dirname, '..', '..', '..', 'templates');
    activateFreshSplitInstructions({ zylosDir, templatesDir });
    const paths = instructionPaths('claude', { zylosDir });
    fs.appendFileSync(paths.userPath, '\nCLEAR_HOOK_SENTINEL\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(paths.userPath, future, future);
    const clearGroup = desiredClaudeHooks({ zylosDir }).SessionStart.find(group => group.matcher === 'clear');
    const assemblerHook = clearGroup.hooks.find(hook => hook.command.includes('assembler.mjs'));
    // The hook runs through the real entry as the run's pane process (this test process).
    const repoRoot = path.join(__dirname, '..', '..', '..');
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, 'skills'), path.join(zylosDir, '.claude', 'skills'));
    writePaneProcess(path.join(zylosDir, 'activity-monitor', 'session-groups', 'origin'),
      { runId: 'clear-hook-run', runtime: 'claude', panePid: process.pid, paneStart: readProcessStart(process.pid) });
    execSync(assemblerHook.command, { stdio: 'pipe',
      env: { ...process.env, ZYLOS_DIR: zylosDir, ZYLOS_RUN_ID: 'clear-hook-run', ZYLOS_PACKAGE_ROOT: repoRoot } });
    assert.equal(fs.existsSync(path.join(zylosDir, 'activity-monitor', 'hook-activity-errors.log')), false);
    assert.match(fs.readFileSync(paths.outputPath, 'utf8'), /CLEAR_HOOK_SENTINEL/);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  });

});

describe('persistInstalledSettingsAndSyncCoupledThreshold', () => {
  const normalizeBackupPath = (filePath) => filePath.replace(/\.bak\.\d+$/, '.bak.<ts>');

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

});

describe('syncCodexConfig', () => {

  function makeCodexHooksEnv() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-sync-test-'));
    const homeDir = path.join(root, 'home');
    const projectDir = path.join(root, 'zylos');
    const globalConfigPath = path.join(homeDir, '.codex', 'config.toml');
    const projectConfigPath = path.join(projectDir, '.codex', 'config.toml');
    // Both TOML configs are already in their desired state, so only
    // .codex/hooks.json can drift.
    const files = new Map([
      [globalConfigPath, renderCodexGlobalConfig(projectDir, '')],
      [projectConfigPath, renderCodexProjectConfig('')],
    ]);
    const writes = [];
    const logs = [];
    const sync = (opts = {}) => syncCodexConfig({
      cfg: { runtime: 'codex' },
      homeDir,
      projectDir,
      existsSync: (filePath) => files.has(filePath),
      readFileSync: (filePath) => files.get(filePath),
      writeConfig: (dir) => {
        writes.push(dir);
        installCoreCodexHook({ zylosDir: dir });
        return true;
      },
      log: (line) => logs.push(line),
      ...opts,
    });
    return { root, projectDir, hooksPath: codexHooksPath(projectDir), writes, logs, sync };
  }


  function hookShardNames(hooksPath) {
    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    return config.hooks.SessionStart
      .flatMap(group => group.hooks.map(h => h.command.match(/--shard (\S+)$/)?.[1]))
      .filter(Boolean);
  }

  it('restores missing core hook entries in .codex/hooks.json', (t) => {
    const env = makeCodexHooksEnv();
    t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
    installCoreCodexHook({ zylosDir: env.projectDir });
    const config = JSON.parse(fs.readFileSync(env.hooksPath, 'utf8'));
    config.hooks.SessionStart[0].hooks.pop();
    fs.writeFileSync(env.hooksPath, JSON.stringify(config, null, 2) + '\n');

    const result = env.sync();

    assert.equal(result.changed, true);
    assert.equal(result.hooksChanged, true);
    assert.equal(hookShardNames(env.hooksPath).at(-1), 'start-prompt');
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


function makeOrchestratorTemplate() {
  return {
    hooks: desiredClaudeHooks({ existsSync: () => true }),
  };
}

function assertSessionStartUsesOrchestrator(settings) {
  assert.equal(settings.hooks.SessionStart.length, 3);
  for (const group of settings.hooks.SessionStart) {
    const coreHooks = group.hooks.filter(h => h.command?.includes('session-start-orchestrator.js'));
    assert.deepEqual(coreHooks.map(h => extractShardArg(h.command)), CORE_SHARD_SEQUENCE);
    for (const hook of coreHooks) {
      assert.equal(hook.timeout, 20000);
    }
  }
}

describe('syncHooks SessionStart orchestrator convergence', () => {
  const noopLog = () => {};

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

  it('is idempotent when installed hooks already match the template', () => {
    const installed = JSON.parse(JSON.stringify(makeOrchestratorTemplate()));

    const result = syncHooks(installed, makeOrchestratorTemplate(), {
      log: noopLog,
      desiredHooks: desiredClaudeHooks({ existsSync: () => true }),
    });

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

    const result = syncHooks(installed, template, { log: noopLog, desiredHooks: template.hooks });

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

    syncHooks(installed, template, { log: noopLog, desiredHooks: template.hooks });

    assert.equal(installed.hooks.SessionStart.length, 3);
    const matchers = installed.hooks.SessionStart.map(g => g.matcher).sort();
    assert.deepEqual(matchers, ['clear', 'compact', 'startup']);
    for (const group of installed.hooks.SessionStart) {
      assert.equal(group.hooks.length, 3);
    }
  });

});
