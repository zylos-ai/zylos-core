import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { restartServicesWithDeps } = await import('../../commands/service.js');

describe('restartServicesWithDeps', () => {
  it('falls back only for the service that failed ecosystem restart', () => {
    const ecosystemCalls = [];
    const managedCalls = [];
    const execCalls = [];
    const messages = [];

    const ok = restartServicesWithDeps({
      restartFromEcosystemFn: (names, opts) => {
        ecosystemCalls.push({ names, opts });
        if (names[0] === 'scheduler') {
          throw new Error('bad ecosystem');
        }
      },
      restartManagedProcessFn: (name, opts) => {
        managedCalls.push({ name, opts });
      },
      getCoreEcosystemPathFn: () => '/tmp/ecosystem.config.cjs',
      execSyncFn: (cmd, opts) => execCalls.push({ cmd, opts }),
      logSuccess: (msg) => messages.push(msg),
      logError: (msg) => messages.push(msg),
    });

    assert.equal(ok, true);
    assert.equal(ecosystemCalls.length, 4);
    assert.deepStrictEqual(managedCalls, [{
      name: 'scheduler',
      opts: {
        ecosystemPath: '/tmp/ecosystem.config.cjs',
        stdio: 'inherit',
        fallbackToPlainRestartOnError: true,
      },
    }]);
    assert.deepStrictEqual(execCalls, [{
      cmd: 'pm2 save 2>/dev/null',
      opts: { stdio: 'inherit' },
    }]);
    assert.equal(messages.some((msg) => String(msg).includes('scheduler')), true);
  });

  it('persists already-restarted services before returning false on a later failure', () => {
    const execCalls = [];
    const messages = [];

    const ok = restartServicesWithDeps({
      restartFromEcosystemFn: (names) => {
        if (names[0] === 'web-console') {
          throw new Error('ecosystem failed');
        }
      },
      restartManagedProcessFn: (name) => {
        if (name === 'web-console') {
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
