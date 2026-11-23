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

  it('uses a bounded named restart stop timeout without updating the process environment', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({ exec: command => calls.push(command) });
    restartManagedProcess('c4-dispatcher', { killTimeoutMs: 10000 });
    assert.deepEqual(calls, ['pm2 restart "c4-dispatcher" --kill-timeout 10000 2>/dev/null']);
    assert.throws(() => restartManagedProcess('c4-dispatcher', { killTimeoutMs: '10000; echo unsafe' }), TypeError);
    assert.equal(calls.length, 1);
  });

});
