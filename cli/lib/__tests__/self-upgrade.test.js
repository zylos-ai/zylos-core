import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  runSelfUpgradeFinalize,
} = await import('../self-upgrade.js');

describe('self-upgrade finalizer handoff', () => {
  for (const state of [
    {schemaVersion: 1}, {schemaVersion: 1, transactionDir: '/untrusted'},
    {schemaVersion: 2}, {schemaVersion: 3, preInstallProtection: true},
  ]) it('rejects unsupported or unprotected finalization before any writes', async () => {
    let calls = 0;
    const result = await runSelfUpgradeFinalize(state, {
      syncSkills() { calls++; throw Error('must not execute'); },
      maintenance: { transaction() { calls++; throw Error('must not inspect'); } },
    });
    assert.equal(result.success, false);
    assert.match(result.error, /protected target-upgrade transaction/);
    assert.equal(calls, 0);
    assert.deepEqual(result.rollback, {performed: false, steps: []});
  });
});
