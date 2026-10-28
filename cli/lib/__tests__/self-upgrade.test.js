import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  createFinalizeState,
  runSelfUpgradeFinalize,
} = await import('../self-upgrade.js');

describe('self-upgrade finalizer handoff', () => {
  it('serializes the protected transaction without an overall deadline', () => {
    const state = createFinalizeState({
      tempDir: '/tmp/new-core', backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'], from: '0.9.3', to: '0.9.4',
      newVersion: '0.9.4', mode: 'merge', preInstallProtection: true,
      transactionDir: '/tmp/transaction', transactionId: 'tx',
    });
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.preInstallProtection, true);
    assert.equal(state.transactionDir, '/tmp/transaction');
    assert.equal(state.transactionId, 'tx');
    assert.equal(Object.hasOwn(state, 'finalizeTimeoutMs'), false);
  });

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
