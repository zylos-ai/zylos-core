import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import * as upgrade from '../../cli/lib/upgrade.js';
import * as self from '../../cli/lib/self-upgrade.js';
import * as discovery from '../../cli/lib/upgrade-discovery.js';

const root = process.env.UPGRADE_CONFIRMATION_ROOT;
for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
  assert.ok(process.env[name].startsWith(root + path.sep), `${name} must be isolated`);
}
const record = name => fs.appendFileSync(path.join(root, 'calls'), name + '\n');
const check = { success: true, hasUpdate: true, current: '1.0.0', latest: '1.0.1', repo: 'fixture/component' };
const download = () => {
  record('download');
  return { success: true, tempDir: path.join(root, 'target') };
};
mock.module('../../cli/lib/upgrade.js', { namedExports: {
  ...upgrade,
  checkForUpdates: () => check,
  downloadToTemp: download,
  readChangelog: () => '',
  runUpgrade: () => { record('upgrade'); return { success: true, from: '1.0.0', to: '1.0.1' }; },
  cleanupTemp: () => record('cleanup'),
} });
mock.module('../../cli/lib/self-upgrade.js', { namedExports: {
  ...self,
  checkForCoreUpdates: () => ({ ...check, hasUpdate: process.env.UPGRADE_MIGRATIONS !== '1' }),
  pendingDatabaseMigrations: () => [{ source: 'c4', fromVersion: 1, toVersion: 2 }],
  downloadCoreToTemp: download,
  copyInstalledCoreToTemp: download,
  readChangelog: () => '',
  cleanupTemp: () => record('cleanup'),
} });
mock.module('../../cli/lib/upgrade-discovery.js', { namedExports: { ...discovery, recoverBeforeUpgrade() {} } });

const { upgradeComponent } = await import('../../cli/commands/component.js');
await upgradeComponent(process.argv.slice(2));
