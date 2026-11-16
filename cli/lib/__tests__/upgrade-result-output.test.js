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
