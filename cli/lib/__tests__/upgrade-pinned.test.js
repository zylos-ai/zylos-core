import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// config.js's SKILLS_DIR/COMPONENTS_DIR/COMPONENTS_FILE etc. are `const`s
// computed ONCE from process.env.ZYLOS_DIR at first import (see
// cli/lib/config.js). node:test isolates each *file* into its own worker
// process (see scripts/run-node-tests.js), so setting ZYLOS_DIR here, before
// the dynamic import below, is safe and does not leak into other test files
// (same pattern as self-upgrade.test.js / secret-store.test.js).
const ZYLOS_FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-installed-version-'));
process.env.ZYLOS_DIR = ZYLOS_FIXTURE_DIR;

const { checkDowngradeSchemaCompatibility, getInstalledVersion, step8_startService } = await import('../upgrade.js');

after(() => {
  fs.rmSync(ZYLOS_FIXTURE_DIR, { recursive: true, force: true });
});

function makeSkillDir(frontmatterExtra = '') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pinned-unit-'));
  const skillDir = path.join(tmpDir, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\n${frontmatterExtra}---\n`, 'utf8');
  return { tmpDir, skillDir };
}

describe('checkDowngradeSchemaCompatibility (#73 requirement 3: refuse incompatible downgrade)', () => {
  it('refuses when the installed schema is newer than the target schema', () => {
    const current = makeSkillDir('lifecycle:\n  data_schema_version: 2\n');
    const target = makeSkillDir('lifecycle:\n  data_schema_version: 1\n');

    try {
      const result = checkDowngradeSchemaCompatibility(current.skillDir, target.skillDir);
      assert.equal(result.compatible, false);
      assert.equal(result.currentSchema, 2);
      assert.equal(result.targetSchema, 1);
      assert.match(result.error, /Refusing downgrade/);
    } finally {
      fs.rmSync(current.tmpDir, { recursive: true, force: true });
      fs.rmSync(target.tmpDir, { recursive: true, force: true });
    }
  });

  it('allows when schemas are equal', () => {
    const current = makeSkillDir('lifecycle:\n  data_schema_version: 3\n');
    const target = makeSkillDir('lifecycle:\n  data_schema_version: 3\n');

    try {
      const result = checkDowngradeSchemaCompatibility(current.skillDir, target.skillDir);
      assert.equal(result.compatible, true);
    } finally {
      fs.rmSync(current.tmpDir, { recursive: true, force: true });
      fs.rmSync(target.tmpDir, { recursive: true, force: true });
    }
  });

  it('allows when the target schema is newer (upgrade direction, or a lower-versioned downgrade target that still declares a higher schema)', () => {
    const current = makeSkillDir('lifecycle:\n  data_schema_version: 1\n');
    const target = makeSkillDir('lifecycle:\n  data_schema_version: 5\n');

    try {
      const result = checkDowngradeSchemaCompatibility(current.skillDir, target.skillDir);
      assert.equal(result.compatible, true);
    } finally {
      fs.rmSync(current.tmpDir, { recursive: true, force: true });
      fs.rmSync(target.tmpDir, { recursive: true, force: true });
    }
  });

  it('defaults to schema 1 for components that never declare the field (non-breaking, requirement 5)', () => {
    const current = makeSkillDir('');
    const target = makeSkillDir('');

    try {
      const result = checkDowngradeSchemaCompatibility(current.skillDir, target.skillDir);
      assert.equal(result.currentSchema, 1);
      assert.equal(result.targetSchema, 1);
      assert.equal(result.compatible, true);
    } finally {
      fs.rmSync(current.tmpDir, { recursive: true, force: true });
      fs.rmSync(target.tmpDir, { recursive: true, force: true });
    }
  });

  it('treats a missing/unreadable currentSkillDir as schema 1 (e.g. half-installed recovery source)', () => {
    const target = makeSkillDir('lifecycle:\n  data_schema_version: 1\n');
    const missingCurrent = path.join(os.tmpdir(), 'zylos-pinned-unit-does-not-exist');

    try {
      const result = checkDowngradeSchemaCompatibility(missingCurrent, target.skillDir);
      assert.equal(result.currentSchema, 1);
      assert.equal(result.compatible, true);
    } finally {
      fs.rmSync(target.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getInstalledVersion (post-condition read-back source of truth)', () => {
  it('reads the same source zylos list uses: components.json, not disk', () => {
    const componentsPath = path.join(ZYLOS_FIXTURE_DIR, '.zylos', 'components.json');
    fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
    fs.writeFileSync(componentsPath, JSON.stringify({
      demo: { version: '2.5.0', repo: 'org/demo' },
    }));

    assert.equal(getInstalledVersion('demo'), '2.5.0');
  });

  it('returns null for a component absent from the registry (e.g. never installed, or half-installed with no registry entry yet)', () => {
    const componentsPath = path.join(ZYLOS_FIXTURE_DIR, '.zylos', 'components.json');
    fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
    fs.writeFileSync(componentsPath, JSON.stringify({ 'some-other-component': { version: '1.0.0' } }));

    assert.equal(getInstalledVersion('component-not-in-registry-at-all'), null);
  });

  it('is independent of on-disk SKILL.md/package.json content -- it is the registry, never the filesystem', () => {
    // A pinned upgrade's success is judged by this value (per component.js's
    // handlePinnedUpgrade), specifically because it is the same source
    // `zylos list` reads -- not by re-parsing SKILL.md, which could disagree
    // with the registry in a half-installed or corrupted state.
    const componentsPath = path.join(ZYLOS_FIXTURE_DIR, '.zylos', 'components.json');
    fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
    fs.writeFileSync(componentsPath, JSON.stringify({ demo: { version: '9.9.9' } }));

    const skillDir = path.join(ZYLOS_FIXTURE_DIR, '.claude', 'skills', 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\nversion: 1.0.0\n---\n');

    assert.equal(getInstalledVersion('demo'), '9.9.9');
  });
});

describe('step8_startService: pinned mode restart failure is non-fatal (#73 requirement 4)', () => {
  it('returns status "skipped" (not "failed") when both direct and ecosystem restart fail, for a pinned upgrade', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pinned-step8-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    try {
      const result = step8_startService({
        component: 'demo',
        skillDir,
        pinned: true,
        serviceWasRunning: false, // component was crashed/not running before the pinned recovery
      }, {
        restartManagedProcess: () => { throw new Error('process missing'); },
        restartFromEcosystem: () => { throw new Error('ecosystem restart also fails'); },
        execSync: () => {},
        existsSync: (file) => file === ecosystemPath,
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /non-fatal for pinned upgrade/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('non-pinned mode keeps the original fatal behavior when both restarts fail (requirement 5: no regression)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-nonpinned-step8-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    try {
      const result = step8_startService({
        component: 'demo',
        skillDir,
        pinned: false,
        serviceWasRunning: true,
      }, {
        restartManagedProcess: () => { throw new Error('process missing'); },
        restartFromEcosystem: () => { throw new Error('ecosystem restart also fails'); },
        execSync: () => {},
        existsSync: (file) => file === ecosystemPath,
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /Failed to restart/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pinned mode force-starts a declared service even if it was not running beforehand (self-healing a crashed component)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pinned-step8-force-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    try {
      const result = step8_startService({
        component: 'demo',
        skillDir,
        pinned: true,
        serviceWasRunning: false,
      }, {
        restartManagedProcess: (name, opts) => calls.push({ name, opts }),
        restartFromEcosystem: () => { throw new Error('should not reach ecosystem fallback'); },
        existsSync: (file) => file === ecosystemPath,
      });

      assert.equal(result.status, 'done');
      assert.deepStrictEqual(calls, [{ name: 'zylos-demo', opts: { ecosystemPath, stdio: 'pipe', save: true } }]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('non-pinned mode still skips restart when the service was not running (unchanged contract)', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  service:\n    name: zylos-demo\n');
    try {
      const result = step8_startService({ component: 'demo', skillDir, pinned: false, serviceWasRunning: false });
      assert.equal(result.status, 'skipped');
      assert.equal(result.message, 'was not running');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pinned mode with no declared service is left alone (nothing to force-start)', () => {
    const { tmpDir, skillDir } = makeSkillDir('');
    try {
      const result = step8_startService({ component: 'demo', skillDir, pinned: true, serviceWasRunning: false });
      assert.equal(result.status, 'skipped');
      assert.equal(result.message, 'no service declared');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
