// CLI-output fixture: replace only installer/protection/database boundaries.
// The downloaded product entry itself runs as the child process main module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = fs.realpathSync(process.env.UPGRADE_ENTRY_FIXTURE_ROOT);
const target = path.join(root, 'target');
const installed = path.join(root, 'prefix/lib/node_modules/zylos');
assert.equal(process.env.ZYLOS_DIR, path.join(root, 'deployment'));
assert.equal(process.env.HOME, path.join(root, 'home'));
const at = name => pathToFileURL(path.join(target, 'cli/lib', name)).href;
const idle = () => {};
const rollback = process.env.UPGRADE_OUTPUT_OUTCOME === 'rollback';
const maintenance = {
  discover: () => ({ candidates: [], diagnostics: [], marker: null }),
  validateSupportedGlobalLayout: idle,
  runInstaller(_directory, _journal, options) {
    if (options.stage === 'pack-target') return JSON.stringify([{ filename: 'target.tgz' }]);
    assert.equal(options.stage, 'install');
    if (rollback) throw Error('npm warn deprecated old-package\nnpm error code 23\nnpm error Target installation failed.\n    at install (fixture.js:1:1)');
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'zylos', type: 'module', version: '1.0.0' }));
    return '';
  },
};
mock.module(at('upgrade-protection.js'), { namedExports: {
  maintenance, maintenanceFor: () => maintenance, beginUpgrade(ctx) {
    if (rollback) {ctx.transactionDir = path.join(root, 'transaction'); ctx.upgradeProtected = true;}
  },
  saveProtectedCode: idle, prepareProtectedInstall: idle, markInstallationIntent: idle,
  timeUpgradeStep: (_ctx, _name, work) => work(),
  recovery: () => {
    assert.ok(rollback, 'successful output fixture must not recover');
    return {attempted:true, completed:true, recovery_required:false};
  },
} });
mock.module(at('upgrade-package.js'), { namedExports: { saveOriginalPackage: idle } });
mock.module(at('core-db-backup.js'), { namedExports: {
  probeCoreDbVersions: () => ({ databases: [{}, {}], needsMigration: false }),
  preflightCoreDbUpgrade: idle, rehearseCoreDbUpgrade: () => assert.fail('no migration in output fixture'),
  inspectFirstDashboardTakeover: () => false, inspectCoreManagesDashboardDb: () => false,
  assertDashboardUninstalled: idle,
} });
