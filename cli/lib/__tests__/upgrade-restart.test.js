import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const { step7_startService } = await import('../upgrade.js');
const { step11_startCoreServices } = await import('../self-upgrade.js');
const { restartRuntimeServices } = await import('../../commands/runtime.js');

describe('step7_startService', () => {
  it('retries deleted services through ecosystem restart instead of pm2 start <name>', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step7-'));
    const skillDir = path.join(tmpDir, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(path.join(skillDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    const result = step7_startService({
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
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "env" ]; then echo "ZYLOS_PACKAGE_ROOT: ${tmpDir}"; fi\n`, { mode: 0o755 });

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
      assert.match(fs.readFileSync(logPath, 'utf8'), /save/);
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
