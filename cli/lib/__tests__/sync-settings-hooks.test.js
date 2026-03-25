import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  shouldSyncCodexConfig,
  syncCodexConfig,
} = await import('../sync-settings-hooks.js');

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
