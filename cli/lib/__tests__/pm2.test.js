import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPm2Helpers } from '../pm2.js';

describe('PM2 ecosystem restart helpers', () => {
  it('restarts all named services through ecosystem config', () => {
    const calls = [];
    const { restartFromEcosystem } = createPm2Helpers({
      exists: (file) => file === '/tmp/ecosystem.config.cjs',
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartFromEcosystem(['activity-monitor', 'c4-dispatcher'], {
      ecosystemPath: '/tmp/ecosystem.config.cjs',
      stdio: 'inherit',
      save: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/ecosystem.config.cjs" --only "activity-monitor" 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 start "/tmp/ecosystem.config.cjs" --only "c4-dispatcher" 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 save 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
    ]);
  });

  it('throws when ecosystem restart is requested without a valid config file', () => {
    const { restartFromEcosystem } = createPm2Helpers({
      exists: () => false,
      exec: () => {
        throw new Error('should not execute');
      },
    });

    assert.throws(
      () => restartFromEcosystem(['activity-monitor'], { ecosystemPath: '/missing/ecosystem.config.cjs' }),
      /ecosystem config not found/
    );
  });

  it('uses ecosystem restart for managed processes when config exists', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: (file) => file === '/tmp/component-ecosystem.config.cjs',
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartManagedProcess('zylos-wecom', {
      ecosystemPath: '/tmp/component-ecosystem.config.cjs',
      stdio: 'pipe',
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/component-ecosystem.config.cjs" --only "zylos-wecom" 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
    ]);
  });

  it('falls back to plain restart only when no ecosystem config exists', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => false,
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartManagedProcess('zylos-custom', {
      ecosystemPath: '/missing/component-ecosystem.config.cjs',
      stdio: 'pipe',
      save: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 restart "zylos-custom" 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
      {
        cmd: 'pm2 save 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
    ]);
  });

  it('can fall back to plain restart when ecosystem restart execution fails', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: (file) => file === '/tmp/core-ecosystem.config.cjs',
      exec: (cmd, opts) => {
        calls.push({ cmd, opts });
        if (cmd.includes('pm2 start "/tmp/core-ecosystem.config.cjs"')) {
          throw new Error('bad ecosystem');
        }
      },
    });

    restartManagedProcess('activity-monitor', {
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      stdio: 'inherit',
      fallbackToPlainRestartOnError: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/core-ecosystem.config.cjs" --only "activity-monitor" 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 restart "activity-monitor" 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
    ]);
  });
});
