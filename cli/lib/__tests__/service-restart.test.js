import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { restartServicesWithDeps } = await import('../../commands/service.js');

describe('restartServicesWithDeps', () => {

  it('persists already-restarted services before returning false on a later failure', () => {
    const execCalls = [];
    const messages = [];

    const ok = restartServicesWithDeps({
      restartFromEcosystemFn: (names) => {
        if (names[0] === 'c4-dispatcher') {
          throw new Error('ecosystem failed');
        }
      },
      restartManagedProcessFn: (name) => {
        if (name === 'c4-dispatcher') {
          throw new Error('fallback failed');
        }
      },
      getCoreEcosystemPathFn: () => '/tmp/ecosystem.config.cjs',
      execSyncFn: (cmd, opts) => execCalls.push({ cmd, opts }),
      logSuccess: (msg) => messages.push(msg),
      logError: (msg) => messages.push(msg),
    });

    assert.equal(ok, false);
    assert.deepStrictEqual(execCalls, [{
      cmd: 'pm2 save 2>/dev/null',
      opts: { stdio: 'inherit' },
    }]);
    assert.equal(messages.some((msg) => String(msg).includes('Failed to restart services')), true);
  });
});
