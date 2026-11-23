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
};

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
