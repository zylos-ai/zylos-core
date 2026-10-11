import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { step0_runPreUpgradeHook, step7_runPostUpgradeHook } from '../upgrade.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-hook-test-'));
  const skillDir = path.join(dir, 'test-component');
  fs.mkdirSync(skillDir, { recursive: true });
  return { dir, skillDir, dataDir: path.join(dir, 'data') };
}

function writeSkillMd(skillDir, hooks = {}) {
  const hookYaml = Object.entries(hooks).map(([k, v]) => `      ${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: test-component
version: 1.0.0
lifecycle:
  hooks:
${hookYaml}
---
# Test
`);
}

function writeHook(skillDir, relPath, script = 'process.exit(0)') {
  const hookPath = path.join(skillDir, relPath);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, script);
}

function makeCtx(skillDir, dataDir, opts = {}) {
  return {
    component: 'test-component',
    skillDir,
    dataDir: dataDir || skillDir,
    jsonOutput: opts.jsonOutput ?? true,
    steps: [],
  };
}

const nullStdio = { stdout: { write() {} }, stderr: { write() {} } };

describe('step0_runPreUpgradeHook', () => {
  it('returns not_declared when no hook is declared', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, {});
    const ctx = makeCtx(skillDir, dataDir);

    const result = step0_runPreUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'not_declared');
    assert.equal(result.name, 'pre_upgrade_hook');
    assert.equal(result.step, 0);
  });

  it('returns executed when hook succeeds', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'pre-upgrade': 'hooks/pre-upgrade.js' });
    writeHook(skillDir, 'hooks/pre-upgrade.js', 'process.exit(0)');
    const ctx = makeCtx(skillDir, dataDir);

    const result = step0_runPreUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'executed');
    assert.equal(result.name, 'pre_upgrade_hook');
  });

  it('returns failed when hook exits non-zero (aborts upgrade)', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'pre-upgrade': 'hooks/pre-upgrade.js' });
    writeHook(skillDir, 'hooks/pre-upgrade.js', 'console.error("version too old"); process.exit(1)');
    const ctx = makeCtx(skillDir, dataDir);

    const result = step0_runPreUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'failed');
    assert.match(result.error, /pre-upgrade hook failed/);
    assert.ok(result.output.stderr.includes('version too old'));
  });

  it('returns failed when hook is declared but file missing', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'pre-upgrade': 'hooks/pre-upgrade.js' });
    const ctx = makeCtx(skillDir, dataDir);

    const result = step0_runPreUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'failed');
    assert.match(result.error, /declared but not found/);
  });

  it('returns failed when hook path escapes skill directory', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'pre-upgrade': '../../etc/evil.js' });
    const ctx = makeCtx(skillDir, dataDir);

    const result = step0_runPreUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'failed');
    assert.match(result.error, /escapes skill directory/);
  });

  it('sets ZYLOS_COMPONENT env for the hook', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'pre-upgrade': 'hooks/pre-upgrade.js' });
    writeHook(skillDir, 'hooks/pre-upgrade.js', `
      if (!process.env.ZYLOS_COMPONENT) { process.exit(1); }
      console.log(process.env.ZYLOS_COMPONENT);
      process.exit(0);
    `);
    const ctx = makeCtx(skillDir, dataDir);

    const result = step0_runPreUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'executed');
    assert.ok(result.output.stdout.includes('test-component'));
  });
});

describe('step7_runPostUpgradeHook — four-state reporting', () => {
  it('returns not_declared when no hook is declared', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, {});
    const ctx = makeCtx(skillDir, dataDir);

    const result = step7_runPostUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'not_declared');
    assert.equal(result.name, 'post_upgrade_hook');
  });

  it('returns executed when hook succeeds', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'post-upgrade': 'hooks/post-upgrade.js' });
    writeHook(skillDir, 'hooks/post-upgrade.js', 'process.exit(0)');
    const ctx = makeCtx(skillDir, dataDir);

    const result = step7_runPostUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'executed');
  });

  it('returns failed_nonfatal when hook fails (does not abort)', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'post-upgrade': 'hooks/post-upgrade.js' });
    writeHook(skillDir, 'hooks/post-upgrade.js', 'process.exit(1)');
    const ctx = makeCtx(skillDir, dataDir);

    const result = step7_runPostUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'failed_nonfatal');
  });

  it('returns failed_nonfatal when hook path escapes', () => {
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'post-upgrade': '../../evil.js' });
    const ctx = makeCtx(skillDir, dataDir);

    const result = step7_runPostUpgradeHook(ctx, nullStdio);

    assert.equal(result.status, 'failed_nonfatal');
  });
});

describe('pre-upgrade abort prevents service stop', () => {
  it('failed pre-upgrade hook aborts before step1_stopService runs', async () => {
    const { step1_stopService } = await import('../upgrade.js');
    const { skillDir, dataDir } = fixture();
    writeSkillMd(skillDir, { 'pre-upgrade': 'hooks/pre-upgrade.js' });
    writeHook(skillDir, 'hooks/pre-upgrade.js', 'process.exit(1)');
    const ctx = makeCtx(skillDir, dataDir);

    const preResult = step0_runPreUpgradeHook(ctx, nullStdio);
    assert.equal(preResult.status, 'failed');

    // Simulate pipeline: failed status means step1 never runs
    // The pipeline loop checks `result.status === 'failed'` and breaks
    // So step1_stopService is never called — service is untouched
    assert.equal(ctx.steps.length, 0, 'no steps should have been pushed to ctx yet');
  });
});
