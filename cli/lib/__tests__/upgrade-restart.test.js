import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';

const { rollback, step7_runPostUpgradeHook, step8_startService } = await import('../upgrade.js');
const { step11_startCoreServices, step12_verifyServices } = await import('../self-upgrade.js');

function makeSkillDir(frontmatter) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-hook-'));
  const skillDir = path.join(tmpDir, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\n${frontmatter}---\n`, 'utf8');
  return { tmpDir, skillDir };
}

describe('step7_runPostUpgradeHook', () => {

  it('skips hook paths that escape the skill directory', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: ../outside.js\n');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        existsSync: () => true,
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /escapes skill directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips hook symlinks that resolve outside the skill directory', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/outside.js\n');
    const outsideHook = path.join(tmpDir, 'outside.js');
    const hookPath = path.join(skillDir, 'hooks', 'outside.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(outsideHook, 'console.log("outside");\n', 'utf8');
    fs.symlinkSync(outsideHook, hookPath);

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /escapes skill directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test('core restart starts ecosystem and saved custom services before strict verification', t => {
  const f=serviceRestartFixture(t);f.custom();
  const ctx={journal:f.j,servicesWereRunning:f.j.originalServices.map(service=>service.name)};
  const result=step11_startCoreServices(ctx,{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(result.status,'done',JSON.stringify(result));
  assert.equal(step12_verifyServices(ctx,{execSync:command=>command.startsWith('sleep')?'':JSON.stringify(f.records())}).status,'done');
  assert.ok(f.calls().some(args=>args[0]==='start'&&args.includes('scheduler')));
  assert.ok(f.calls().some(args=>JSON.stringify(args)===JSON.stringify(['restart','custom-service','--update-env'])));
  assert.ok(f.records().every(record=>record.pm2_env.status==='online'));
  assert.ok(!f.calls().some(args=>args[0]==='delete'));
});

describe('step8_startService', () => {

  it('persists the PM2 dump (save: true) on a normal upgrade restart (#1696)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-save-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      restartFromEcosystem: () => {
        throw new Error('should not reach ecosystem fallback on the happy path');
      },
      existsSync: (file) => file === ecosystemPath,
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [{
      name: 'zylos-demo',
      opts: { ecosystemPath, stdio: 'pipe', save: true },
    }]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

});

describe('component upgrade rollback', () => {
  it('restores from skillDir/.backup/<timestamp> and preserves backup metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-rollback-'));
    const skillDir = path.join(tmpDir, 'skills', 'demo');
    const backupDir = path.join(skillDir, '.backup', 'run-1');

    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(skillDir, '.zylos'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'SKILL.md'), 'old\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'broken\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'new-file.txt'), 'remove\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, '.zylos', 'manifest.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, '.zylos', 'other-metadata.json'), 'keep\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'node_modules', 'keep.txt'), 'deps\n', 'utf8');

    const results = rollback({
      backupDir,
      skillDir,
      serviceWasRunning: false,
    });

    assert.equal(results.some((item) => item.action === 'restore_files' && item.success), true);
    assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), 'old\n');
    assert.equal(fs.existsSync(path.join(skillDir, 'new-file.txt')), false);
    assert.equal(fs.readFileSync(path.join(skillDir, '.backup', 'run-1', 'SKILL.md'), 'utf8'), 'old\n');
    assert.equal(fs.readFileSync(path.join(skillDir, 'node_modules', 'keep.txt'), 'utf8'), 'deps\n');
    // #715 commit-boundary contract: rollback never touches .zylos because
    // the outer pipeline commits the new baseline only after every failing
    // step has succeeded. The pre-upgrade baseline and other metadata stay.
    assert.equal(results.some((item) => item.action === 'restore_baseline'), false);
    assert.equal(fs.readFileSync(path.join(skillDir, '.zylos', 'manifest.json'), 'utf8'), '{}\n');
    assert.equal(fs.readFileSync(path.join(skillDir, '.zylos', 'other-metadata.json'), 'utf8'), 'keep\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

});

describe('step11_startCoreServices', () => {

  it('fails before saving when activity-monitor restarts without refreshed package-root env', t => {
    const f=serviceRestartFixture(t,{names:['activity-monitor']});
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['activity-monitor'],
    }, {
      fs: {
        existsSync: () => true,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      ecosystemPath: f.file,
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      verifyActivityMonitorEnv: () => false,
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /ZYLOS_PACKAGE_ROOT/);
    assert.equal(calls.some(call => call.type === 'exec' && call.cmd === 'pm2 save 2>/dev/null'), false);
  });
});
