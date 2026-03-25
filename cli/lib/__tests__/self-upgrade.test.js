import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { step10_ensureCodexConfig } = await import('../self-upgrade.js');

describe('step10_ensureCodexConfig', () => {
  it('skips codex config write when non-codex runtime has no codex state', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'claude' },
      codexDir: '/tmp/fake-codex-none',
      existsSync: () => false,
      writeConfig: () => {
        throw new Error('should not be called');
      }
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.message, 'codex not in use');
  });

  it('treats codex config write failure as best-effort outside codex runtime', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'claude' },
      codexDir: '/tmp/fake-codex',
      existsSync: () => true,
      writeConfig: () => false
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.message, /warning: failed to refresh ~\/\.codex\/config\.toml outside codex runtime/);
  });

  it('still fails when codex runtime cannot write codex config', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'codex' },
      codexDir: '/tmp/fake-codex',
      existsSync: () => true,
      writeConfig: () => false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'failed to write ~/.codex/config.toml');
  });
});
