/**
 * Protected entry controller with real step 5 merge. Package/service operations
 * and compensation are local fixtures, not real installation/recovery evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runUpgradeEntry } from '../../cli/lib/upgrade-entry.js';
import { step5_syncCoreSkills } from '../../cli/lib/self-upgrade.js';
import { printStep } from '../../cli/commands/component.js';

const [tempDir, scenario] = process.argv.slice(2);
const zylosDir = process.env.ZYLOS_DIR;
if (!tempDir || !scenario || !zylosDir) throw Error('Expected tempDir, scenario and ZYLOS_DIR');
const skillsDir = path.join(zylosDir, '.claude/skills');
const transactionBackupDir = path.join(zylosDir, '.backup/self-upgrade/conflict-fixture/code');
const operations = [];
const launcherOutput = [];
const originalLog = console.log;
console.log = (...args) => launcherOutput.push(args.join(' '));
let result;
try {
  result = await runUpgradeEntry({schemaVersion:1, fromVersion:'0.9.3',
    installedRoot:tempDir, tempDir, zylosDir}, {
    maintenance:{discover:() => ({candidates:[], diagnostics:[], marker:null})},
    inspect:() => ({tempDir, zylosDir, skillsDir, mode:'merge'}),
    resolveNpm:() => '/fixture/npm-cli.js',
    begin(ctx) {
      ctx.upgradeProtected = true;
      ctx.transactionId = 'conflict-fixture';
      ctx.transactionDir = path.dirname(transactionBackupDir);
      fs.mkdirSync(ctx.transactionDir, {recursive:true});
      fs.writeFileSync(path.join(ctx.transactionDir, 'journal.json'), JSON.stringify({
        transactionId:ctx.transactionId, phase:'installing', installationIntent:true,
      }));
      ctx.releaseControl = () => operations.push('release');
    },
    savePackage:() => operations.push('save-package'),
    saveCode() {
      fs.cpSync(skillsDir, path.join(transactionBackupDir, 'skills'), {recursive:true});
      operations.push('save-code');
    },
    prepare:() => operations.push('snapshot-and-stop'),
    install:() => operations.push('install'),
    finalize(ctx) {
      const step = step5_syncCoreSkills(ctx, {zylosDir});
      if (scenario !== 'json') printStep(step);
      if (step.status === 'failed') throw Error(step.error);
      if (scenario === 'later-failure') return {success:false, failedStep:6,
        error:'injected dependency installation failure', mergeConflicts:ctx.mergeConflicts};
      // Protected terminal cleanup can remove code while retaining conflicts.
      fs.rmSync(transactionBackupDir, {recursive:true, force:true});
      return {success:true, mergeConflicts:ctx.mergeConflicts.length ? ctx.mergeConflicts : null};
    },
    recover() {
      operations.push('compensate');
      fs.rmSync(skillsDir, {recursive:true, force:true});
      fs.cpSync(path.join(transactionBackupDir, 'skills'), skillsDir, {recursive:true});
      return {attempted:true, completed:true, recovery_required:false};
    },
  });
} finally {
  console.log = originalLog;
}
originalLog(JSON.stringify({result, launcherOutput, operations, transactionBackupDir}));
