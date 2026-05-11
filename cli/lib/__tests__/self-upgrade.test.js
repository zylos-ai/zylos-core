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
  step10_ensureCodexConfig,
} = await import('../self-upgrade.js');
const { generateMigrationHints, applyMigrationHints } = await import('../self-upgrade.js');

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
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor', 'c4-dispatcher'],
      from: '0.4.12',
      to: '0.4.13',
      newVersion: '0.4.13',
      mode: 'merge',
    });
  });

  it('runs post-install steps with restored state and returns upgrade metadata', () => {
    const calls = [];
    const result = runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesStopped: ['activity-monitor'],
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
      mode: 'merge',
    }, {
      steps: [
        (ctx) => {
          calls.push({
            tempDir: ctx.tempDir,
            backupDir: ctx.backupDir,
            servicesWereRunning: ctx.servicesWereRunning,
            mode: ctx.mode,
          });
          return { step: 5, name: 'sync_core_skills', status: 'done', message: 'ok' };
        },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.from, '0.4.12');
    assert.equal(result.to, '0.4.13');
    assert.equal(result.backupDir, '/tmp/backup');
    assert.equal(result.steps.length, 1);
    assert.deepEqual(calls, [{
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      mode: 'merge',
    }]);
  });

  it('fails without rollback when a post-install step fails', () => {
    const result = runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
    }, {
      steps: [
        () => ({ step: 5, name: 'sync_core_skills', status: 'failed', error: 'sync failed' }),
      ],
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 5);
    assert.equal(result.error, 'sync failed');
    assert.deepEqual(result.rollback, { performed: false, steps: [] });
  });
});

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
    assert.match(result.message, /warning: failed to refresh codex config outside codex runtime/);
  });

  it('still fails when codex runtime cannot write codex config', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'codex' },
      codexDir: '/tmp/fake-codex',
      existsSync: () => true,
      writeConfig: () => false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'failed to write codex config');
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

describe('Claude model migration hints', () => {
  it('adds a model backfill hint when the installed settings omit model', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-model-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    assert.deepEqual(
      hints.filter((hint) => hint.type === 'model_backfill'),
      [{ type: 'model_backfill', value: 'claude-opus-4-6' }]
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not add a model backfill hint when the user already configured model', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-model-nohint-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    assert.equal(hints.some((hint) => hint.type === 'model_backfill'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills model during applyMigrationHints only when the field is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-model-apply-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const settingsPath = path.join(zylosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }) + '\n', 'utf8');

    const result = applyMigrationHints([{ type: 'model_backfill', value: 'claude-opus-4-6' }], { zylosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(result.applied, 1);
    assert.equal(updated.model, 'claude-opus-4-6');

    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet' }) + '\n', 'utf8');
    const preserved = applyMigrationHints([{ type: 'model_backfill', value: 'claude-opus-4-6' }], { zylosDir });
    const preservedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(preserved.applied, 0);
    assert.equal(preservedSettings.model, 'sonnet');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('Boolean setting migration hints (autoMemoryEnabled, autoDreamEnabled)', () => {
  it('adds setting_backfill hints when installed settings omit them', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-setting-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false, autoDreamEnabled: false }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    const settingHints = hints.filter((h) => h.type === 'setting_backfill');
    assert.equal(settingHints.length, 2);
    assert.deepEqual(settingHints[0], { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false });
    assert.deepEqual(settingHints[1], { type: 'setting_backfill', key: 'autoDreamEnabled', value: false });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not add hints when user already configured the settings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-setting-nohint-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false, autoDreamEnabled: false }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: true, autoDreamEnabled: true }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    assert.equal(hints.some((h) => h.type === 'setting_backfill'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills settings during applyMigrationHints only when absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-setting-apply-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const settingsPath = path.join(zylosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }) + '\n', 'utf8');

    const result = applyMigrationHints([
      { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false },
      { type: 'setting_backfill', key: 'autoDreamEnabled', value: false },
    ], { zylosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(result.applied, 2);
    assert.equal(updated.autoMemoryEnabled, false);
    assert.equal(updated.autoDreamEnabled, false);

    // User-configured values should be preserved
    fs.writeFileSync(settingsPath, JSON.stringify({ autoMemoryEnabled: true, autoDreamEnabled: true }) + '\n', 'utf8');
    const preserved = applyMigrationHints([
      { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false },
      { type: 'setting_backfill', key: 'autoDreamEnabled', value: false },
    ], { zylosDir });
    const preservedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(preserved.applied, 0);
    assert.equal(preservedSettings.autoMemoryEnabled, true);
    assert.equal(preservedSettings.autoDreamEnabled, true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
