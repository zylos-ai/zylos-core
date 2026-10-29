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
    assert.equal(result.recovery_required,true);
  });
});
