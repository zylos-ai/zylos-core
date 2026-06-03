import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const {
  rollback,
  shouldRestartServiceAfterUpgrade,
  step7_runPostUpgradeHook,
  step8_startService,
} = await import('../upgrade.js');
const { step11_startCoreServices } = await import('../self-upgrade.js');
const { restartRuntimeServices } = await import('../../commands/runtime.js');

function makeSkillDir(frontmatter) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-hook-'));
  const skillDir = path.join(tmpDir, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\n${frontmatter}---\n`, 'utf8');
  return { tmpDir, skillDir };
}

describe('step7_runPostUpgradeHook', () => {
  it('skips when no post-upgrade hook is declared', () => {
    const { tmpDir, skillDir } = makeSkillDir('');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'skipped');
      assert.equal(result.message, 'no post-upgrade hook');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips when the declared hook file is missing', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir });

      assert.equal(result.status, 'skipped');
      assert.equal(result.message, 'hook not found: hooks/post-upgrade.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs an existing hook and returns captured output', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'console.log("ok");\n', 'utf8');
    const stdoutWrites = [];
    const stderrWrites = [];

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: false }, {
        spawnSync: (cmd, args, opts) => {
          assert.equal(cmd, process.execPath);
          assert.deepEqual(args, [hookPath]);
          assert.equal(opts.cwd, skillDir);
          assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
          return { status: 0, stdout: 'hook stdout\n', stderr: 'hook stderr\n' };
        },
        stdout: { write: (value) => stdoutWrites.push(value) },
        stderr: { write: (value) => stderrWrites.push(value) },
      });

      assert.equal(result.status, 'done');
      assert.equal(result.message, 'hooks/post-upgrade.js');
      assert.deepEqual(result.output, { stdout: 'hook stdout\n', stderr: 'hook stderr\n' });
      assert.deepEqual(stdoutWrites, ['hook stdout\n']);
      assert.deepEqual(stderrWrites, ['hook stderr\n']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats a failing hook as non-fatal and keeps diagnostics', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'process.exit(1);\n', 'utf8');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: true }, {
        spawnSync: () => ({ status: 1, stdout: 'before fail\n', stderr: 'bad things\n' }),
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /hook had issues/);
      assert.match(result.message, /bad things/);
      assert.deepEqual(result.output, { stdout: 'before fail\n', stderr: 'bad things\n' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not replay hook output when jsonOutput is enabled', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'console.log("json safe");\n', 'utf8');
    const stdoutWrites = [];
    const stderrWrites = [];

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: true }, {
        spawnSync: () => ({ status: 0, stdout: 'hook stdout\n', stderr: 'hook stderr\n' }),
        stdout: { write: (value) => stdoutWrites.push(value) },
        stderr: { write: (value) => stderrWrites.push(value) },
      });

      assert.equal(result.status, 'done');
      assert.deepEqual(result.output, { stdout: 'hook stdout\n', stderr: 'hook stderr\n' });
      assert.deepEqual(stdoutWrites, []);
      assert.deepEqual(stderrWrites, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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

describe('step8_startService', () => {
  it('restarts declared services unless PM2 status shows an intentional stop', () => {
    assert.equal(shouldRestartServiceAfterUpgrade('online'), true);
    assert.equal(shouldRestartServiceAfterUpgrade('errored'), true);
    assert.equal(shouldRestartServiceAfterUpgrade('launching'), true);
    assert.equal(shouldRestartServiceAfterUpgrade('waiting restart'), true);
    assert.equal(shouldRestartServiceAfterUpgrade('unknown'), true);
    assert.equal(shouldRestartServiceAfterUpgrade('stopped'), false);
    assert.equal(shouldRestartServiceAfterUpgrade('stopping'), false);
  });

  for (const status of ['errored', 'launching', 'waiting restart', 'unexpected']) {
    it(`restarts services that were ${status} before upgrade`, () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-restart-'));
      const skillDir = path.join(tmpDir, 'demo');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
      fs.writeFileSync(path.join(skillDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n', 'utf8');

      const calls = [];
      try {
        const result = step8_startService({
          component: 'demo',
          skillDir,
          serviceInitialStatus: status,
          serviceShouldRestart: true,
          serviceWasRunning: false,
        }, {
          restartManagedProcess: (name, opts) => {
            calls.push({ name, opts });
          },
        });

        assert.equal(result.status, 'done');
        assert.equal(result.message, 'zylos-demo');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'zylos-demo');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }

  for (const status of ['stopped', 'stopping']) {
    it(`skips services that were intentionally ${status} before upgrade`, () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-stopped-'));
      const skillDir = path.join(tmpDir, 'demo');
      fs.mkdirSync(skillDir, { recursive: true });

      try {
        const result = step8_startService({
          component: 'demo',
          skillDir,
          serviceInitialStatus: status,
          serviceShouldRestart: false,
          serviceWasRunning: false,
        }, {
          restartManagedProcess: () => {
            throw new Error('should not restart');
          },
        });

        assert.equal(result.status, 'skipped');
        assert.equal(result.message, `was not running (${status})`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }

  it('retries deleted services through ecosystem restart instead of pm2 start <name>', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-'));
    const skillDir = path.join(tmpDir, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(path.join(skillDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: () => {
        throw new Error('process missing');
      },
      restartFromEcosystem: (names, opts) => {
        calls.push({ type: 'ecosystem', names, opts });
      },
      execSync: (cmd) => {
        calls.push({ type: 'exec', cmd });
      },
      existsSync: (file) => file === path.join(skillDir, 'ecosystem.config.cjs'),
    });

    assert.equal(result.status, 'done');
    assert.equal(calls.some((call) => call.type === 'ecosystem' && call.names[0] === 'zylos-demo'), true);
    assert.equal(calls.some((call) => call.type === 'exec' && call.cmd === 'pm2 start zylos-demo 2>/dev/null'), false);

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
    assert.equal(fs.readFileSync(path.join(skillDir, '.zylos', 'manifest.json'), 'utf8'), '{}\n');
    assert.equal(fs.readFileSync(path.join(skillDir, 'node_modules', 'keep.txt'), 'utf8'), 'deps\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('step11_startCoreServices', () => {
  it('passes the core ecosystem path instead of null when no template is available yet', () => {
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['activity-monitor'],
    }, {
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      verifyActivityMonitorEnv: () => true,
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [{
      name: 'activity-monitor',
      opts: {
        ecosystemPath: '/tmp/core-ecosystem.config.cjs',
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      },
    }, {
      type: 'exec',
      cmd: 'pm2 save 2>/dev/null',
    }]);
  });

  it('uses the module default restart helper when no restart dep is injected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step11-default-'));
    const binDir = path.join(tmpDir, 'bin');
    const logPath = path.join(tmpDir, 'pm2.log');
    const ecosystemPath = path.join(tmpDir, 'ecosystem.config.cjs');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "jlist" ]; then echo '[{"name":"activity-monitor","pm_id":3,"pm2_env":{"status":"online","ZYLOS_PACKAGE_ROOT":"${tmpDir}"}}]'; fi\n`, { mode: 0o755 });

    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step11_startCoreServices({
        tempDir: null,
        servicesWereRunning: ['activity-monitor'],
      }, {
        fs: {
          existsSync: (file) => file === ecosystemPath,
          mkdirSync: () => {},
          copyFileSync: () => {},
        },
        ecosystemPath,
      });

      assert.equal(result.status, 'done');
      assert.match(fs.readFileSync(logPath, 'utf8'), /start .*ecosystem\.config\.cjs.*--only activity-monitor/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /--update-env/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /^jlist$/m);
      assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /^env activity-monitor$/m);
      assert.match(fs.readFileSync(logPath, 'utf8'), /save/);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails before saving when pm2 jlist lacks activity-monitor package-root env', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step11-jlist-missing-'));
    const binDir = path.join(tmpDir, 'bin');
    const logPath = path.join(tmpDir, 'pm2.log');
    const ecosystemPath = path.join(tmpDir, 'ecosystem.config.cjs');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "jlist" ]; then echo '[{"name":"activity-monitor","pm_id":3,"pm2_env":{"status":"online"}}]'; fi\n`, { mode: 0o755 });

    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step11_startCoreServices({
        tempDir: null,
        servicesWereRunning: ['activity-monitor'],
      }, {
        fs: {
          existsSync: (file) => file === ecosystemPath,
          mkdirSync: () => {},
          copyFileSync: () => {},
        },
        ecosystemPath,
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /ZYLOS_PACKAGE_ROOT/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /^jlist$/m);
      assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /^save$/m);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails before saving when activity-monitor restarts without refreshed package-root env', () => {
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['activity-monitor'],
    }, {
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
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

describe('restartRuntimeServices', () => {
  it('falls back to plain restart when the core ecosystem file is missing', () => {
    const calls = [];

    restartRuntimeServices({
      services: ['activity-monitor'],
      ecosystemPath: '/missing/core-ecosystem.config.cjs',
      restartManagedProcessFn: (name, opts) => {
        calls.push({ name, opts });
      },
      logSuccess: () => {},
      logWarning: () => {},
    });

    assert.deepStrictEqual(calls, [{
      name: 'activity-monitor',
      opts: {
        ecosystemPath: '/missing/core-ecosystem.config.cjs',
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      },
    }]);
  });
});
