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
      restartFromEcosystem: (names, opts) => {
        calls.push({ names, opts });
      },
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [{
      names: ['activity-monitor'],
      opts: { ecosystemPath: '/tmp/core-ecosystem.config.cjs', stdio: 'pipe' },
    }]);
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
