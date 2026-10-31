import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  runSelfUpgradeFinalize,
} = await import('../self-upgrade.js');

describe('self-upgrade finalizer handoff', () => {
  for (const defect of ['missing journal', 'foreign transaction', 'missing intent', 'wrong phase']) it(`rejects ${defect} before any writes`, async () => {
    let calls = 0;
    const journal={transactionId:defect==='foreign transaction'?'other':'tx',installationIntent:defect!=='missing intent',phase:defect==='wrong phase'?'prepared':'installing'};
    const result = await runSelfUpgradeFinalize({transactionId:'tx',transactionDir:'/untrusted'}, {
      syncSkills() { calls++; throw Error('must not execute'); },
      maintenance: {
        transaction() {if(defect==='missing journal')throw Error('missing journal');return journal;},
        canRecognizeProcesses:()=>true,
      },
    });
    assert.equal(result.success, false);
    assert.match(result.error, /missing journal|invalid initial finalizer transaction/);
    assert.equal(calls, 0);
    assert.deepEqual(result.rollback, {performed: false, steps: []});
    assert.equal(Object.hasOwn(result,'recovery_required'),false);
    assert.equal(Object.hasOwn(result,'recoveryError'),false);
    assert.equal(Object.hasOwn(result,'next'),false);
  });

  it('rejects Dashboard admission before journal validation without recovery guidance', async () => {
    const result=await runSelfUpgradeFinalize({transactionId:'tx',transactionDir:'/untrusted'}, {
      assertDashboardUninstalled() {throw Object.assign(Error('Dashboard is still installed'),{code:'DASHBOARD_STILL_INSTALLED'});},
      maintenance:{transaction(){assert.fail('admission failure read a transaction');},canRecognizeProcesses:()=>true},
    });
    assert.equal(result.success,false);
    assert.equal(result.code,'DASHBOARD_STILL_INSTALLED');
    assert.equal(Object.hasOwn(result,'recovery_required'),false);
    assert.equal(Object.hasOwn(result,'recoveryError'),false);
    assert.equal(Object.hasOwn(result,'next'),false);
  });

  for (const code of ['EACCES', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'SQLITE_BUSY']) it(`preserves ${code} during initial finalizer admission`, async () => {
    const result=await runSelfUpgradeFinalize({transactionId:'tx',transactionDir:'/untrusted'}, {
      assertDashboardUninstalled() {throw Object.assign(Error('components registry could not be read'),{code});},
      maintenance:{transaction(){assert.fail('admission failure read a transaction');},canRecognizeProcesses:()=>true},
    });
    assert.equal(result.success,false);
    assert.equal(result.code,code);
    assert.equal(result.failedStep,null);
    assert.equal(result.steps.at(-1).name,'finalize');
    assert.equal(Object.hasOwn(result,'recovery_required'),false);
  });
});
