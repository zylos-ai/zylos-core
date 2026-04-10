import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const {
  migrateMatcherSplit,
  shouldSyncCodexConfig,
  syncCodexConfig,
  syncHooks,
  syncTemplateSetting,
  syncTemplateModelSetting,
} = await import('../sync-settings-hooks.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_SETTINGS_PATH = path.join(__dirname, '..', '..', '..', 'templates', '.claude', 'settings.json');

describe('Claude settings template', () => {
  it('defaults fresh installs to the Opus model', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    assert.equal(template.model, 'opus');
  });

  it('disables autoMemoryEnabled and autoDreamEnabled by default', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    assert.equal(template.autoMemoryEnabled, false);
    assert.equal(template.autoDreamEnabled, false);
  });

  it('includes session-foreground hooks for all SessionStart matchers', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    const groups = template.hooks.SessionStart;
    assert.equal(groups.length, 3);
    for (const group of groups) {
      const commands = group.hooks.map(h => h.command);
      assert.ok(commands.some(cmd => cmd.includes('session-foreground.js')));
    }
  });

  it('includes PostToolUseFailure activity hook', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    const groups = template.hooks.PostToolUseFailure || [];
    assert.equal(groups.length, 1);
    assert.ok(groups[0].hooks.some(h => h.command.includes('hook-activity.js')));
  });
});

describe('syncTemplateModelSetting', () => {
  it('backfills the template model when the installed settings omit model', () => {
    const installedSettings = {};
    const logs = [];

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'opus' },
      installedSettings,
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.equal(installedSettings.model, 'opus');
    assert.deepEqual(logs, ['  + model: opus']);
  });

  it('preserves an existing user-configured model', () => {
    const installedSettings = { model: 'sonnet' };

    const result = syncTemplateModelSetting({
      templateSettings: { model: 'opus' },
      installedSettings,
      log: () => {
        throw new Error('should not log when model already exists');
      },
    });

    assert.equal(result.changed, false);
    assert.equal(installedSettings.model, 'sonnet');
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

// --- migrateMatcherSplit tests ---
describe('migrateMatcherSplit', () => {
  const noopLog = () => {};

  it('splits a catch-all into specific matchers', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js', '/skills/b/scripts/b.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js', '/skills/b/scripts/b.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js', '/skills/b/scripts/b.js']),
          makeMatcherGroup('compact', ['/skills/a/scripts/a.js', '/skills/b/scripts/b.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { log: noopLog });

    assert.equal(count, 3);
    assert.equal(installed.hooks.SessionStart.length, 3);
    const matchers = installed.hooks.SessionStart.map(g => g.matcher).sort();
    assert.deepEqual(matchers, ['clear', 'compact', 'startup']);
    for (const group of installed.hooks.SessionStart) {
      assert.equal(group.hooks.length, 2);
    }
  });

  it('skips when no catch-all exists in installed config', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { log: noopLog });
    assert.equal(count, 0);
    assert.equal(installed.hooks.SessionStart.length, 1);
  });

  it('skips when template also has a catch-all', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { log: noopLog });
    assert.equal(count, 0);
  });

  it('skips when catch-all has user hooks not in template', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js', '/custom/user-hook.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { log: noopLog });
    assert.equal(count, 0);
    assert.equal(installed.hooks.SessionStart.length, 1);
    assert.equal(installed.hooks.SessionStart[0].matcher, '');
  });

  it('does not duplicate matchers that already exist', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('compact', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { log: noopLog });
    assert.equal(count, 3);
    assert.equal(installed.hooks.SessionStart.length, 3);
    const matchers = installed.hooks.SessionStart.map(g => g.matcher).sort();
    assert.deepEqual(matchers, ['clear', 'compact', 'startup']);
  });

  it('dryRun does not modify installed config', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { dryRun: true, log: noopLog });
    assert.equal(count, 2);
    assert.equal(installed.hooks.SessionStart.length, 1);
    assert.equal(installed.hooks.SessionStart[0].matcher, '');
  });

  it('handles undefined matcher as catch-all', () => {
    const installed = {
      hooks: {
        SessionStart: [
          { hooks: [makeHook('/skills/a/scripts/a.js')] },
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { log: noopLog });
    assert.equal(count, 1);
    assert.equal(installed.hooks.SessionStart.length, 1);
    assert.equal(installed.hooks.SessionStart[0].matcher, 'startup');
  });

  it('preserves hook content (command, timeout) during split', () => {
    const installed = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [
            { type: 'command', command: 'node /skills/a/scripts/a.js', timeout: 5000 },
            { type: 'command', command: 'node /skills/b/scripts/b.js', timeout: 15000 },
          ],
        }],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js', '/skills/b/scripts/b.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js', '/skills/b/scripts/b.js']),
        ],
      },
    };

    migrateMatcherSplit(installed, template, { log: noopLog });

    for (const group of installed.hooks.SessionStart) {
      assert.equal(group.hooks[0].timeout, 5000);
      assert.equal(group.hooks[1].timeout, 15000);
      assert.ok(group.hooks[0].command.includes('a.js'));
      assert.ok(group.hooks[1].command.includes('b.js'));
    }
  });

  it('handles empty hooks gracefully', () => {
    const count1 = migrateMatcherSplit({}, {}, { log: noopLog });
    assert.equal(count1, 0);

    const count2 = migrateMatcherSplit({ hooks: {} }, { hooks: {} }, { log: noopLog });
    assert.equal(count2, 0);
  });

  it('works across multiple events independently', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js']),
        ],
        Stop: [
          makeMatcherGroup('', ['/skills/b/scripts/b.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js']),
        ],
        Stop: [
          makeMatcherGroup('success', ['/skills/b/scripts/b.js']),
        ],
      },
    };

    const count = migrateMatcherSplit(installed, template, { log: noopLog });
    assert.equal(count, 3);
    assert.equal(installed.hooks.SessionStart.length, 2);
    assert.equal(installed.hooks.Stop.length, 1);
    assert.equal(installed.hooks.Stop[0].matcher, 'success');
  });

  it('logs migration actions', () => {
    const logs = [];
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('', ['/skills/a/scripts/a.js']),
        ],
      },
    };
    const template = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', ['/skills/a/scripts/a.js']),
          makeMatcherGroup('clear', ['/skills/a/scripts/a.js']),
        ],
      },
    };

    migrateMatcherSplit(installed, template, { log: (msg) => logs.push(msg) });
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes('SessionStart'));
    assert.ok(logs[0].includes('startup'));
    assert.ok(logs[0].includes('clear'));
  });
});

// --- syncHooks (forward + reverse pass) tests ---
describe('syncHooks forward pass', () => {
  const noopLog = () => {};

  it('does not modify user-owned matcher group (respects user intent)', () => {
    const installed = {
      hooks: {
        SessionStart: [
          makeMatcherGroup('startup', [
            '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
            '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
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

    const result = syncHooks(installed, template, { log: noopLog });

    // startup should NOT gain a 3rd hook
    const startupGroup = installed.hooks.SessionStart.find(g => g.matcher === 'startup');
    assert.equal(startupGroup.hooks.length, 2);

    // clear and compact should be added
    assert.equal(installed.hooks.SessionStart.length, 3);
    const clearGroup = installed.hooks.SessionStart.find(g => g.matcher === 'clear');
    const compactGroup = installed.hooks.SessionStart.find(g => g.matcher === 'compact');
    assert.ok(clearGroup);
    assert.ok(compactGroup);
    assert.equal(clearGroup.hooks.length, 3);
    assert.equal(compactGroup.hooks.length, 3);
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

    // User's custom hook should still be there (startup group exists, not modified)
    const startupGroup = installed.hooks.SessionStart.find(g => g.matcher === 'startup');
    assert.equal(startupGroup.hooks.length, 1);
    assert.ok(startupGroup.hooks[0].command.includes('my-hook.js'));
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
