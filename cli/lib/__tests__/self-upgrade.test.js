import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const { step1_backupCoreSkills, rollbackSelf, step10_ensureCodexConfig } = await import('../self-upgrade.js');

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

describe('self-upgrade backup and rollback', () => {
  it('backs up the deployed core ecosystem file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-backup-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');

    fs.mkdirSync(path.join(zylosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'pm2', 'ecosystem.config.cjs'), 'module.exports = { apps: ["old"] };\n', 'utf8');

    const ctx = {};
    const result = step1_backupCoreSkills(ctx, {
      zylosDir,
      skillsDir,
      backupDir,
    });

    assert.equal(result.status, 'done');
    assert.equal(
      fs.readFileSync(path.join(backupDir, 'pm2', 'ecosystem.config.cjs'), 'utf8'),
      'module.exports = { apps: ["old"] };\n'
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the backed-up ecosystem before restarting services', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-rollback-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');
    const ecosystemPath = path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');

    fs.mkdirSync(path.join(backupDir, 'pm2'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'pm2', 'ecosystem.config.cjs'), 'module.exports = { apps: ["restored"] };\n', 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: ["broken-new"] };\n', 'utf8');

    const restartCalls = [];
    const results = rollbackSelf({
      backupDir,
      servicesWereRunning: ['activity-monitor'],
    }, {
      zylosDir,
      skillsDir,
      ecosystemPath,
      restartManagedProcess: (name, opts) => {
        restartCalls.push({
          name,
          opts,
          ecosystemContent: fs.readFileSync(opts.ecosystemPath, 'utf8'),
        });
      },
    });

    assert.equal(
      fs.readFileSync(ecosystemPath, 'utf8'),
      'module.exports = { apps: ["restored"] };\n'
    );
    assert.deepStrictEqual(restartCalls, [{
      name: 'activity-monitor',
      opts: { ecosystemPath, stdio: 'pipe', fallbackToPlainRestartOnError: true },
      ecosystemContent: 'module.exports = { apps: ["restored"] };\n',
    }]);
    assert.equal(results.some((item) => item.action === 'restore_pm2_ecosystem' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to plain restart when the backup has no ecosystem file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-rollback-fallback-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');
    const ecosystemPath = path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');

    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(zylosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    const restartCalls = [];
    const results = rollbackSelf({
      backupDir,
      servicesWereRunning: ['activity-monitor'],
    }, {
      zylosDir,
      skillsDir,
      ecosystemPath,
      restartManagedProcess: (name, opts) => {
        restartCalls.push({ name, opts });
      },
    });

    assert.deepStrictEqual(restartCalls, [{
      name: 'activity-monitor',
      opts: { ecosystemPath, stdio: 'pipe', fallbackToPlainRestartOnError: true },
    }]);
    assert.equal(results.some((item) => item.action === 'restart_activity-monitor' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
