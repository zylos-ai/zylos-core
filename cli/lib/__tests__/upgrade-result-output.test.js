import test from 'node:test';
import assert from 'node:assert/strict';
import { outputUpgradeResult } from '../upgrade-entry.js';

function capture(result, options) {
  let stdout = '', stderr = '';
  outputUpgradeResult(result, options, {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  return { stdout, stderr };
}

const warnings = {
  serviceWarnings: ['Restart the custom service manually.'],
  warnings: ['Run zylos init to finish cleanup.', { runtime: 'codex', code: 'RUNTIME_CLI_UNAVAILABLE', message: 'Optional CLI unavailable.' }],
  corePackageWarnings: [{ code: 'CORE_PACKAGE_LOCATION_WRITE_FAILED', message: 'Rerun zylos init to record the package.' }],
  checkpointAudit: { state: 'incomplete', items: [{ checkpointId: 7, repairRequired: true }] },
};

test('human success starts a new line and reports versions and actionable warnings', () => {
  const result = { success: true, from: '1.0.0', to: '1.1.0', ...warnings };
  const { stdout, stderr } = capture(result, { jsonOutput: false });
  assert.equal(stdout, '\nzylos-core upgraded: 1.0.0 → 1.1.0.\n');
  assert.match(stderr, /Service warning: Restart the custom service manually\./);
  assert.match(stderr, /Upgrade warning: Run zylos init to finish cleanup\./);
  assert.match(stderr, /Runtime warning \(codex\): Optional CLI unavailable\./);
  assert.match(stderr, /Core package location warning: Rerun zylos init/);
  assert.match(stderr, /checkpoint 7 .* requires repair/);
  assert.match(stderr, /audit incomplete/);
  assert.doesNotMatch(stdout + stderr, /RUNTIME_CLI_UNAVAILABLE|CORE_PACKAGE_LOCATION_WRITE_FAILED|"success"|undefined/);
});

test('human failure reports Error and optional Next without protocol fields', () => {
  const result = { success: false, code: 'UPGRADE_RECOVERY_REQUIRED', error: 'Recover the unfinished upgrade first.', next: 'zylos recovery status', persisted: [] };
  assert.deepEqual(capture(result, { jsonOutput: false }), {
    stdout: '\n', stderr: 'Error: Recover the unfinished upgrade first.\nNext: zylos recovery status\n',
  });
  assert.deepEqual(capture({ success: false, error: 'Target is unavailable.' }, { jsonOutput: false }), {
    stdout: '\n', stderr: 'Error: Target is unavailable.\n',
  });
});

test('human recovery failure reports incomplete rollback and default recovery instructions', () => {
  const result = { success: false, error: 'Skill dependency installation failed.', recovery_required: true,
    rollback: { attempted: true, completed: false, recovery_required: true, error: 'EACCES' } };
  const before = JSON.stringify(result);
  for (const attempted of [true, false]) {
    assert.deepEqual(capture({ ...result, rollback: { ...result.rollback, attempted } }, { jsonOutput: false }), {
      stdout: '\n', stderr: 'Error: Skill dependency installation failed.\n'
        + 'Upgrade warning: Rollback did not complete. Upgrade is blocked until recovery completes.\n'
        + 'Next: Run zylos recovery status, then zylos recovery resume before upgrading.\n',
    });
  }
  for (const options of [undefined, { jsonOutput: true }]) {
    assert.deepEqual(capture(result, options), { stdout: before + '\n', stderr: '' });
  }
  assert.equal(JSON.stringify(result), before);
});

test('human recovery failure preserves supplied instructions without inventing a rollback', () => {
  const result = { success: false, error: 'Recover the unfinished upgrade first.', recovery_required: true,
    rollback: { attempted: false, completed: false, performed: false },
    next: 'Run zylos recovery status to inspect the transaction.' };
  assert.deepEqual(capture(result, { jsonOutput: false }), {
    stdout: '\n', stderr: 'Error: Recover the unfinished upgrade first.\n'
      + 'Upgrade warning: Upgrade is blocked until recovery completes.\n'
      + `Next: ${result.next}\n`,
  });
});

test('human success reports Dashboard follow-up instructions', () => {
  const result = { success: true, from: '1.0.0', to: '1.1.0',
    next: 'Dashboard is not ready. Fix the cause reported in dashboard.errors, run zylos init to retry.' };
  const before = JSON.stringify(result);
  assert.deepEqual(capture(result, { jsonOutput: false }), {
    stdout: '\nzylos-core upgraded: 1.0.0 → 1.1.0.\n', stderr: `Next: ${result.next}\n`,
  });
  for (const options of [undefined, { jsonOutput: true }]) {
    assert.deepEqual(capture(result, options), { stdout: before + '\n', stderr: '' });
  }
  assert.equal(JSON.stringify(result), before);
});

test('only completed and attempted rollback reports the restored source version', () => {
  const result = {success:false, from:'1.0.0-beta.11', error:'Target installation failed.',
    rollback:{attempted:true, completed:true}};
  const before = JSON.stringify(result);
  assert.match(capture(result, {jsonOutput:false}).stderr, /Rollback completed\. zylos-core has been restored to 1\.0\.0-beta\.11\./);
  for (const rollback of [{attempted:true, completed:false}, {attempted:false, completed:true}, {performed:false}]) {
    assert.doesNotMatch(capture({...result, rollback}, {jsonOutput:false}).stderr, /has been restored/);
  }
  assert.doesNotMatch(capture({...result, from:undefined}, {jsonOutput:false}).stderr, /has been restored/);
  assert.equal(capture(result).stdout, before + '\n');
  assert.equal(JSON.stringify(result), before);
});

for (const success of [true, false]) test(`explicit and legacy JSON preserve every result field (${success})`, () => {
  const result = { action: 'self_upgrade', success, from: '1.0.0', to: success ? '1.1.0' : null,
    code: success ? undefined : 'UPGRADE_FAILED', error: success ? undefined : 'Installation failed.',
    rollback: { attempted: !success, completed: !success }, persisted: [], ...warnings };
  const before = JSON.stringify(result);
  for (const options of [undefined, {}, { jsonOutput: true }]) {
    const { stdout, stderr } = capture(result, options);
    assert.equal(stdout, before + '\n');
    assert.deepEqual(JSON.parse(stdout), JSON.parse(before));
    assert.match(stderr, /Runtime warning \(codex\): RUNTIME_CLI_UNAVAILABLE: Optional CLI unavailable\./);
  }
  assert.equal(JSON.stringify(result), before);
});
