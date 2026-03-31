import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const {
  migrateMatcherSplit,
  shouldSyncCodexConfig,
  syncCodexConfig,
  syncTemplateModelSetting,
} = await import('../sync-settings-hooks.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_SETTINGS_PATH = path.join(__dirname, '..', '..', '..', 'templates', '.claude', 'settings.json');

describe('Claude settings template', () => {
  it('defaults fresh installs to the Opus model', () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_PATH, 'utf8'));
    assert.equal(template.model, 'opus');
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
    const configPath = '/tmp/home/.codex/config.toml';

    const result = syncCodexConfig({
      cfg: { runtime: 'claude' },
      homeDir: '/tmp/home',
      projectDir: '/tmp/zylos',
      existsSync: (filePath) => filePath === configPath,
      readFileSync: () => 'model = "gpt-5.3-codex"\n',
      renderConfig: () => 'model = "gpt-5.3-codex"\n[features]\nmulti_agent = true\n',
      writeConfig: (projectDir) => {
        writes.push(projectDir);
        return true;
      },
      log: (line) => logs.push(line),
    });

    assert.equal(result.changed, true);
    assert.deepEqual(writes, ['/tmp/zylos']);
    assert.ok(logs.some(line => line.includes('codex config')));
  });

  it('treats refresh failures as fatal only in codex runtime', () => {
    const result = syncCodexConfig({
      cfg: { runtime: 'codex' },
      homeDir: '/tmp/home',
      projectDir: '/tmp/zylos',
      existsSync: () => true,
      readFileSync: () => 'model = "gpt-5.3-codex"\n',
      renderConfig: () => 'model = "gpt-5.3-codex"\n[features]\nmulti_agent = true\n',
      writeConfig: () => false,
      log: () => {},
    });

    assert.equal(result.fatal, true);
    assert.match(result.error, /Failed to refresh/);
  });
});

// --- Helper to build hook entries ---
function makeHook(scriptPath, timeout = 10000) {
  return { type: 'command', command: `node ${scriptPath}`, timeout };
}

function makeMatcherGroup(matcher, scriptPaths) {
  return {
    matcher,
    hooks: scriptPaths.map(p => makeHook(p)),
  };
}

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
    // Each group should have the same hooks
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
    // Original catch-all should be preserved
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
    assert.equal(count, 3); // count reflects template matchers, not actually added
    // startup already existed, catch-all removed, clear + compact added
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
    // Config unchanged
    assert.equal(installed.hooks.SessionStart.length, 1);
    assert.equal(installed.hooks.SessionStart[0].matcher, '');
  });

  it('handles undefined matcher as catch-all', () => {
    const installed = {
      hooks: {
        SessionStart: [
          { hooks: [makeHook('/skills/a/scripts/a.js')] }, // no matcher field = undefined
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
    assert.equal(count, 3); // 2 for SessionStart + 1 for Stop
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
