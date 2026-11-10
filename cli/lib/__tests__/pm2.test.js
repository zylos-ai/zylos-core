import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPm2Helpers } from '../pm2.js';

function recordCall(calls, cmd, opts) {
  if (cmd.startsWith('pm2 start ')) {
    assert.equal(Object.hasOwn(opts.env, 'ZYLOS_RUN_ID'), false);
    assert.equal(Object.hasOwn(opts.env, 'ZYLOS_SESSION_GROUP'), false);
    const { env, ...rest } = opts;
    calls.push({ cmd, opts: rest });
  } else calls.push({ cmd, opts });
}

describe('PM2 ecosystem restart helpers', () => {
  it('restarts all named services through ecosystem config', () => {
    const calls = [];
    const { restartFromEcosystem } = createPm2Helpers({
      exists: (file) => file === '/tmp/ecosystem.config.cjs',
      exec: (cmd, opts) => recordCall(calls, cmd, opts),
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
      exec: (cmd, opts) => recordCall(calls, cmd, opts),
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
      exec: (cmd, opts) => recordCall(calls, cmd, opts),
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

  it('uses a bounded named restart stop timeout without updating the process environment', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({ exec: command => calls.push(command) });
    restartManagedProcess('c4-dispatcher', { killTimeoutMs: 10000 });
    assert.deepEqual(calls, ['pm2 restart "c4-dispatcher" --kill-timeout 10000 2>/dev/null']);
    assert.throws(() => restartManagedProcess('c4-dispatcher', { killTimeoutMs: '10000; echo unsafe' }), TypeError);
    assert.equal(calls.length, 1);
  });

  it('recreates the process from ecosystem when ecosystem restart execution fails', () => {
    const calls = [];
    let startAttempts = 0;
    const { restartManagedProcess } = createPm2Helpers({
      exists: (file) => file === '/tmp/core-ecosystem.config.cjs',
      exec: (cmd, opts) => {
        recordCall(calls, cmd, opts);
        if (cmd.includes('pm2 start "/tmp/core-ecosystem.config.cjs"')) {
          startAttempts += 1;
        }
        if (cmd.includes('pm2 start "/tmp/core-ecosystem.config.cjs"') && startAttempts === 1) {
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
});
