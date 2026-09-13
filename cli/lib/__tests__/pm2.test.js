import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPm2Helpers } from '../pm2.js';

describe('PM2 ecosystem restart helpers', () => {
  it('restarts all named services through ecosystem config', () => {
    const calls = [];
    const { restartFromEcosystem } = createPm2Helpers({
      exists: (file) => file === '/tmp/ecosystem.config.cjs',
      exec: (cmd, opts) => calls.push({ cmd, opts }),
      execOptions: (stdio) => ({ stdio }),
    });

    restartFromEcosystem(['activity-monitor', 'c4-dispatcher'], {
      ecosystemPath: '/tmp/ecosystem.config.cjs',
      stdio: 'inherit',
      save: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/ecosystem.config.cjs" --only "activity-monitor" --update-env 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 start "/tmp/ecosystem.config.cjs" --only "c4-dispatcher" --update-env 2>/dev/null',
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
      execOptions: (stdio) => ({ stdio }),
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
      execOptions: (stdio) => ({ stdio }),
    });

    restartManagedProcess('zylos-wecom', {
      ecosystemPath: '/tmp/component-ecosystem.config.cjs',
      stdio: 'pipe',
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/component-ecosystem.config.cjs" --only "zylos-wecom" --update-env 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
    ]);
  });

  it('falls back to plain restart only when no ecosystem config exists', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => false,
      exec: (cmd, opts) => calls.push({ cmd, opts }),
      execOptions: (stdio) => ({ stdio }),
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

  it('recreates the process from ecosystem when ecosystem restart execution fails', () => {
    const calls = [];
    let startAttempts = 0;
    const { restartManagedProcess } = createPm2Helpers({
      exists: (file) => file === '/tmp/core-ecosystem.config.cjs',
      exec: (cmd, opts) => {
        calls.push({ cmd, opts });
        if (cmd.includes('pm2 start "/tmp/core-ecosystem.config.cjs"')) {
          startAttempts += 1;
        }
        if (cmd.includes('pm2 start "/tmp/core-ecosystem.config.cjs"') && startAttempts === 1) {
          throw new Error('bad ecosystem');
        }
      },
      execOptions: (stdio) => ({ stdio }),
    });

    restartManagedProcess('activity-monitor', {
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      stdio: 'inherit',
      fallbackToPlainRestartOnError: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/core-ecosystem.config.cjs" --only "activity-monitor" --update-env 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 delete "activity-monitor" 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 start "/tmp/core-ecosystem.config.cjs" --only "activity-monitor" --update-env 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
    ]);
  });

  it('executes pm2 commands with the managed environment by default', () => {
    const calls = [];
    const { restartFromEcosystem } = createPm2Helpers({
      exists: (file) => file === '/tmp/ecosystem.config.cjs',
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartFromEcosystem(['zylos-dashboard'], {
      ecosystemPath: '/tmp/ecosystem.config.cjs',
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].cmd, /pm2 start/);
    assert.equal(calls[0].opts.stdio, 'pipe');
    assert.equal(typeof calls[0].opts.env.PATH, 'string');
  });
});
