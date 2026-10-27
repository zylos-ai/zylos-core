import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const {
  createFinalizeState,
  runSelfUpgradeFinalize,
  step1_backupCoreSkills,
  rollbackSelf,
} = await import('../self-upgrade.js');

describe('self-upgrade finalizer handoff', () => {
  it('serializes the state needed by the newly installed finalizer', () => {
    assert.deepEqual(createFinalizeState({
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor', 'c4-dispatcher'],
      from: '0.4.12',
      to: '0.4.13',
      newVersion: '0.4.13',
      mode: 'merge',
    }), {
      schemaVersion: 1,
      finalizeTimeoutMs: 600000,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor', 'c4-dispatcher'],
      from: '0.4.12',
      to: '0.4.13',
      newVersion: '0.4.13',
      mode: 'merge',
    });
  });

  it('restores state into the production pipeline and ignores obsolete steps injection', async () => {
    const calls = [];
    const result = await runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesStopped: ['activity-monitor'],
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
      mode: 'merge',
    }, {
      budget: { check() {} },
      steps: [() => { throw Error('obsolete pipeline must not run'); }],
      assertDashboardUninstalled() {},
      syncSkills(ctx) {
        calls.push({ tempDir: ctx.tempDir, backupDir: ctx.backupDir,
          servicesWereRunning: ctx.servicesWereRunning, mode: ctx.mode });
        return { step: 5, name: 'sync_core_skills', status: 'done' };
      },
      installDependencies: () => ({ step: 6, name: 'install_skill_deps', status: 'done' }),
      prepareRuntimeClis() {},
      migrateDatabases() {},
      prepareRuntime: () => ({ replacements: [], warnings: [] }),
      stage() { throw Error('stop after restored state reaches staging'); },
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'stop after restored state reaches staging');
    assert.equal(result.from, '0.4.12');
    assert.equal(result.to, null);
    assert.equal(result.steps.length, 3);
    assert.deepEqual(calls, [{
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      mode: 'merge',
    }]);
  });

  it('fails without rollback when production skill synchronization fails', async () => {
    const result = await runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
    }, {
      budget: { check() {} },
      assertDashboardUninstalled() {},
      syncSkills: () => ({ step: 5, name: 'sync_core_skills', status: 'failed', error: 'sync failed' }),
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 5);
    assert.equal(result.error, 'sync failed');
    assert.deepEqual(result.rollback, { performed: false, steps: [] });
  });

  it('rejects each declared transaction field in schema 1 without running ordinary steps', async () => {
    for (const declaration of [
      { transactionDir: '/untrusted/transaction' },
      { transactionId: 'declared-transaction' },
      { preInstallProtection: true },
    ]) {
      let calls = 0;
      const result = await runSelfUpgradeFinalize({ schemaVersion: 1, ...declaration }, {
        syncSkills() { calls++; return { step: 5, status: 'done' }; },
        maintenance: { transaction() { throw Error('must not read declared schema 1 transaction'); } },
      });
      assert.equal(result.success, false, JSON.stringify(declaration));
      assert.equal(result.action, 'self_upgrade');
      assert.match(result.error, /Declared upgrade transaction/);
      assert.equal(calls, 0);
      assert.deepEqual(result.rollback, { performed: false, steps: [] });
    }
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

  it('backs up real skill contents when the skills root is a symlink', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-symlink-backup-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const realSkillsDir = path.join(tmpDir, 'real-skills');
    const skillsDir = path.join(zylosDir, '.claude', 'skills');
    const backupDir = path.join(tmpDir, 'backup');

    fs.mkdirSync(path.dirname(skillsDir), { recursive: true });
    fs.mkdirSync(path.join(realSkillsDir, 'activity-monitor'), { recursive: true });
    fs.mkdirSync(path.join(realSkillsDir, 'lark'), { recursive: true });
    fs.writeFileSync(path.join(realSkillsDir, 'activity-monitor', 'SKILL.md'), '# Activity Monitor\n', 'utf8');
    fs.writeFileSync(path.join(realSkillsDir, 'lark', 'SKILL.md'), '# Lark\n', 'utf8');
    fs.symlinkSync(realSkillsDir, skillsDir);

    const ctx = {};
    const result = step1_backupCoreSkills(ctx, {
      zylosDir,
      skillsDir,
      backupDir,
    });

    assert.equal(result.status, 'done');
    assert.equal(fs.lstatSync(path.join(backupDir, 'skills')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(backupDir, 'skills')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(backupDir, 'skills', 'activity-monitor', 'SKILL.md'), 'utf8'), '# Activity Monitor\n');
    assert.equal(fs.readFileSync(path.join(backupDir, 'skills', 'lark', 'SKILL.md'), 'utf8'), '# Lark\n');

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
