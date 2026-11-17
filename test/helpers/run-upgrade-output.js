import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { upgradeSelfCore, runDownloadedUpgrade } from '../../cli/commands/component.js';

const root = process.env.UPGRADE_ENTRY_FIXTURE_ROOT;
const jsonOutput = process.argv[2] === 'json';
function runTarget(input) {
  return runDownloadedUpgrade(input, { spawn(node, args, options) {
    const flags = process.argv[3] !== 'failure'
      ? ['--experimental-test-module-mocks', '--import', path.resolve('cli/lib/__tests__/fixtures/upgrade-entry-output.js')]
      : [];
    return spawnSync(node, [...flags, ...args], { ...options, env:{...options.env, UPGRADE_OUTPUT_OUTCOME:process.argv[3]}, timeout: 10000 });
  } });
}
if (process.argv[2] === 'legacy') {
  // Exact handoff shape used by the published legacy bridges.
  process.exitCode = runTarget({ schemaVersion: 1, fromVersion: '0.9.6',
    tempDir: path.join(root, 'target'), installedRoot: path.join(root, 'prefix/lib/node_modules/zylos'),
    zylosDir: process.env.ZYLOS_DIR });
} else {
  const ok = await upgradeSelfCore({ jsonOutput, skipConfirm: true }, {
    installedRoot: path.join(root, 'prefix/lib/node_modules/zylos'),
    zylosDir: process.env.ZYLOS_DIR,
    recoverBeforeUpgrade() {},
    checkForCoreUpdates: () => ({ success: true, hasUpdate: true, current: '1.0.0-beta.11', latest: '1.0.0' }),
    downloadCoreToTemp: () => ({ success: true, tempDir: path.join(root, 'target') }),
    readCoreChangelog: () => 'Release notes without trailing newline',
    filterChangelog: value => value,
    detectCoreSkillChanges: () => [],
    runDownloadedUpgrade: runTarget,
    // Deliberately unterminated preview reproduces the original terminal seam.
    console: { log: value => process.stdout.write(String(value)), error: value => process.stderr.write(value + '\n') },
    cleanupCoreTemp() {},
  });
  if (!ok) process.exitCode = 1;
}
