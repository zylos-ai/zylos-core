import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acquireUsageProbeLock, releaseUsageProbeLock } from '../usage-probe-lock.js';

function withTempLockFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-lock-test-'));
  const lockFile = path.join(dir, 'usage.lock');
  try {
    fn(lockFile);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}

describe('usage-probe-lock', () => {
  it('acquires and releases lock with token check', () => {
    withTempLockFile((lockFile) => {
      const acquire = acquireUsageProbeLock({
        lockFile,
        ttlSeconds: 120,
        sessionName: 'probe-a',
        sessionExistsFn: () => true,
      });

      assert.equal(acquire.ok, true);
      assert.equal(releaseUsageProbeLock({ lockFile, token: 'wrong' }), false);
      assert.equal(releaseUsageProbeLock({ lockFile, token: acquire.token }), true);
    });
  });

  it('returns lock_busy for active lock', () => {
    withTempLockFile((lockFile) => {
      const first = acquireUsageProbeLock({
        lockFile,
        ttlSeconds: 120,
        sessionName: 'probe-a',
        sessionExistsFn: () => true,
      });
      assert.equal(first.ok, true);

      const second = acquireUsageProbeLock({
        lockFile,
        ttlSeconds: 120,
        sessionName: 'probe-b',
        sessionExistsFn: () => true,
      });

      assert.equal(second.ok, false);
      assert.equal(second.reason, 'lock_busy');
    });
  });

  it('reclaims stale lock when pid is dead', () => {
    withTempLockFile((lockFile) => {
      fs.writeFileSync(lockFile, JSON.stringify({
        pid: 999999,
        startedAt: 1,
        token: 'old',
        sessionName: 'probe-old',
      }));

      const result = acquireUsageProbeLock({
        lockFile,
        ttlSeconds: 120,
        sessionName: 'probe-new',
        sessionExistsFn: () => false,
      });

      assert.equal(result.ok, true);
    });
  });
});
