/**
 * Isolated #717 self-upgrade seam.
 *
 * This drives the real old-launcher runSelfUpgrade() orchestration, the real
 * finalizer state serialization/restore APIs, real step 5 smart merge, and
 * the old launcher's printStep callback. A real child awaits the production
 * finalizer pipeline, with npm, PM2 and unrelated preparation effects injected
 * so the host installation is never touched.
 *
 * argv: <package-temp-dir> <success|json|later-failure|no-conflict>
 * stdout: one JSON object containing the result and captured launcher output
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [tempDir, scenario] = process.argv.slice(2);
const zylosDir = process.env.ZYLOS_DIR;
if (!tempDir || !scenario || !zylosDir) {
  throw new Error('Usage: run-self-upgrade-driver.mjs <tempDir> <scenario> with ZYLOS_DIR');
}

const {
  cleanupBackup,
  createFinalizeState,
  runSelfUpgrade,
  runSelfUpgradeFinalize,
  step5_syncCoreSkills,
  step1_backupCoreSkills,
  step2_preUpgradeHook,
  step3_stopCoreServices,
  step4_npmInstallGlobal,
} = await import('../../cli/lib/self-upgrade.js');
const { printStep } = await import('../../cli/commands/component.js');

if (tempDir === '--finalize') {
  const state = JSON.parse(fs.readFileSync(scenario, 'utf8'));
  const finalizerScenario = process.argv[4];
  const budget = { check() {}, remaining: () => 60000, deadlineAt: Date.now() + 60000 };
  const finalized = await runSelfUpgradeFinalize(state, {
    zylosDir, budget,
    syncSkills: ctx => step5_syncCoreSkills(ctx, { zylosDir }),
    installDependencies: () => ({ step: 6, name: 'install_skill_dependencies',
      status: finalizerScenario === 'later-failure' ? 'failed' : 'done',
      ...(finalizerScenario === 'later-failure' ? { error: 'injected later failure' } : {}) }),
    prepareRuntimeClis() {}, migrateDatabases() {},
    prepareRuntime: () => ({ replacements: [], warnings: [] }),
    ensureMemoryMigration() {}, commitBaselines() {}, startServices() {}, verifyServices() {},
    dashboardOwner: {
      applyDashboardRegistration: () => ({ state: 'done' }),
      applyDashboardRoute: () => ({ state: 'done' }),
      verifyDashboard: () => ({ state: 'ready', errors: [] }),
    },
    readModeStatus: () => ({ sessionMode: 'single', transition: null }),
    readMode: () => ({ mode: 'single' }), readTransition: () => null,
    restart: () => ({ ok: true, data: { result: 'exit_enqueued' } }), audit: () => [],
  });
  process.stdout.write(JSON.stringify(finalized));
  process.exit(0);
}

const transactionBackupDir = path.join(zylosDir, 'zylos-core-backup-717-transaction');
const npmCommands = [];
const stoppedServices = [];
const launcherOutput = [];
const originalLog = console.log;
console.log = (...args) => launcherOutput.push(args.join(' '));

let result;
try {
  result = runSelfUpgrade({
    tempDir,
    newVersion: '0.5.4-test',
    mode: 'merge',
    onStep: scenario === 'json' ? undefined : printStep,
  }, {
    // Explicitly exercise the legacy #717 seam; default runs use v2 protection.
    preInstallSteps: [
      ctx=>step1_backupCoreSkills(ctx,{zylosDir,skillsDir:path.join(zylosDir,'.claude','skills'),backupDir:transactionBackupDir}),
      step2_preUpgradeHook,
      ctx=>step3_stopCoreServices(ctx,{getSkillsServices:()=>[{name:'fixture-service',status:'online'}],stopService:name=>stoppedServices.push(name)}),
      ctx=>step4_npmInstallGlobal(ctx,{execSync:command=>{npmCommands.push(command);return command.startsWith('npm pack')?'zylos-fixture.tgz\n':'';}}),
    ],
    getCurrentVersion: () => ({ success: true, version: '0.5.3' }),
    step1: {
      zylosDir,
      skillsDir: path.join(zylosDir, '.claude', 'skills'),
      backupDir: transactionBackupDir,
    },
    step3: {
      getSkillsServices: () => [{ name: 'fixture-service', status: 'online' }],
      stopService: (name) => stoppedServices.push(name),
    },
    step4: {
      execSync: (command) => {
        npmCommands.push(command);
        return command.startsWith('npm pack') ? 'zylos-fixture.tgz\n' : '';
      },
    },
    runInstalledFinalizer: (ctx) => {
      const stateFile = path.join(tempDir, 'fixture-finalize-state.json');
      fs.writeFileSync(stateFile, JSON.stringify(createFinalizeState(ctx)));
      const child = spawnSync(process.execPath, [import.meta.filename, '--finalize', stateFile, scenario], {
        encoding: 'utf8', timeout: 60000,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw Error(child.stderr || `fixture finalizer exited ${child.status}`);
      return JSON.parse(child.stdout);
    },
  });

  // Match component.js: legacy success cleanup applies to both output modes.
  if (result.success && !result.preInstallProtection && result.backupDir) {
    cleanupBackup(result.backupDir);
  }
} finally {
  console.log = originalLog;
}

originalLog(JSON.stringify({
  result,
  launcherOutput,
  npmCommands,
  stoppedServices,
  transactionBackupDir,
}));
