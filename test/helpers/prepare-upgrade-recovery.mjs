import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {beginUpgrade, saveProtectedCode, prepareProtectedInstall, markInstallationIntent, closeCompensation, maintenance} from '../../cli/lib/upgrade-protection.js';
import {createCoreDbSnapshot} from '../../cli/lib/core-db-backup.js';

const {root, driverRoot, closed} = JSON.parse(process.argv[2]);
const zylosDir = path.join(root, 'h/zylos');
for (const [key, expected] of Object.entries({HOME:path.join(root, 'h'), ZYLOS_DIR:zylosDir,
  PM2_HOME:path.join(root, 'pm2'), TMPDIR:path.join(root, 't')})) assert.equal(process.env[key], expected);
const skillsDir = path.join(zylosDir, '.claude/skills');
const owner = path.join(skillsDir, 'comm-bridge');
fs.mkdirSync(owner, {recursive:true});
fs.writeFileSync(path.join(owner, 'package.json'), '{"type":"module"}\n');
fs.writeFileSync(path.join(owner, 'service.cjs'), 'original deployment\n');
fs.symlinkSync(driverRoot, path.join(owner, 'node_modules'));
const Database = createRequire(import.meta.url)(path.join(driverRoot, 'better-sqlite3'));
const databaseFile = path.join(zylosDir, 'comm-bridge/c4.db');
fs.mkdirSync(path.dirname(databaseFile), {recursive:true});
const database = new Database(databaseFile);
database.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('isolated test database');");
database.close();
const databaseHash = maintenance.hash(databaseFile);
const coreDir = path.join(root, 'original-package'), tempDir = path.join(root, 'target-package');
for (const directory of [coreDir, tempDir]) fs.mkdirSync(path.join(directory, 'skills/comm-bridge'), {recursive:true});
fs.mkdirSync(path.join(coreDir, 'cli/lib'), {recursive:true});
fs.copyFileSync(new URL('../../cli/lib/core-db-backup-worker.js', import.meta.url), path.join(coreDir, 'cli/lib/core-db-backup-worker.js'));
fs.writeFileSync(path.join(coreDir, 'package.json'), '{"version":"0.9.3"}\n');
const ctx = {coreDir, tempDir, from:'0.9.3', to:'0.9.4', databaseMode:'unchanged', targetOwned:closed};
beginUpgrade(ctx, {zylosDir, skillsDir});
saveProtectedCode(ctx);
let snapshotCalls = 0;
prepareProtectedInstall(ctx, {snapshot:options => {
  snapshotCalls++;
  return createCoreDbSnapshot(options);
}});
assert.equal(snapshotCalls, 1);
markInstallationIntent(ctx);
const descriptor = maintenance.read(path.join(ctx.transactionDir, 'descriptor.json'));
maintenance.validateDescriptor(ctx.transactionDir, ctx.journal, descriptor);
assert.equal(Object.hasOwn(ctx.journal, 'recoveryHashes'), false);
assert.deepEqual(Object.keys(descriptor.hashes).sort(), ['finalizer.cjs', 'maintenance.cjs', 'runner.cjs']);
fs.writeFileSync(path.join(owner, 'service.cjs'), 'interrupted deployment\n');
if (closed) {
  closeCompensation(ctx);
  maintenance.update(ctx.transactionDir, ctx.journal, {phase:'recovery_required', resumePhase:'compensation_closed'});
}
process.stdout.write(JSON.stringify({ready:true, transactionDir:ctx.transactionDir, transactionId:ctx.transactionId,
  installationIntent:ctx.journal.installationIntent, descriptor, databaseHash}) + '\n');
// Leave real controller admission owned until the parent kills this process.
setInterval(() => {}, 1000);
