import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const {
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
