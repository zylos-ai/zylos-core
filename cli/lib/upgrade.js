/**
 * Core upgrade logic for components
 * Implements the 9-step upgrade flow with automatic rollback
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { SKILLS_DIR, COMPONENTS_DIR } = require('./config');
const { acquireLock, releaseLock } = require('./lock');
const git = require('./git');
const { loadComponents, saveComponents } = require('./components');

/**
 * Check if a component has updates available
 * @param {string} component - Component name
 * @returns {object} Update check result
 */
async function checkForUpdates(component) {
  const skillDir = path.join(SKILLS_DIR, component);

  // Verify component exists
  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'component_not_found',
      message: `组件 '${component}' 未安装`,
    };
  }

  // Get current version
  const localVersion = git.getLocalVersion(skillDir);
  if (!localVersion.success) {
    return {
      success: false,
      error: 'version_not_found',
      message: `无法读取当前版本: ${localVersion.error}`,
    };
  }

  // Get upgrade branch
  const branch = git.getUpgradeBranch(skillDir);

  // Check for remote changes
  const remoteChanges = git.hasRemoteChanges(skillDir, branch);
  if (!remoteChanges.success) {
    return {
      success: false,
      error: 'fetch_failed',
      message: `无法检查更新: ${remoteChanges.error}`,
    };
  }

  if (!remoteChanges.hasChanges) {
    return {
      success: true,
      hasUpdate: false,
      current: localVersion.version,
      latest: localVersion.version,
    };
  }

  // Get remote version
  const remoteVersion = git.getRemoteVersion(skillDir, branch);
  if (!remoteVersion.success) {
    return {
      success: false,
      error: 'remote_version_failed',
      message: `无法读取远程版本: ${remoteVersion.error}`,
    };
  }

  // Get changelog
  const changelog = git.getRemoteChangelog(skillDir, branch);

  // Check for local changes
  const localChanges = git.hasLocalChanges(skillDir);

  return {
    success: true,
    hasUpdate: true,
    current: localVersion.version,
    latest: remoteVersion.version,
    changelog: changelog.changelog,
    localCommit: remoteChanges.localCommit,
    remoteCommit: remoteChanges.remoteCommit,
    localChanges: localChanges.hasChanges ? localChanges.changes : null,
    branch,
  };
}

/**
 * Create upgrade context object
 */
function createContext(component) {
  const skillDir = path.join(SKILLS_DIR, component);
  const dataDir = path.join(COMPONENTS_DIR, component);

  return {
    component,
    skillDir,
    dataDir,
    // State tracking
    rollbackPoint: null,
    stashName: null,
    packageLockBackup: null,
    lockAcquired: false,
    serviceStopped: false,
    serviceWasRunning: false,
    hadLocalChanges: false,
    // Results
    steps: [],
    from: null,
    to: null,
    success: false,
    error: null,
  };
}

/**
 * Step 1: Acquire upgrade lock
 */
function step1_acquireLock(ctx) {
  const startTime = Date.now();
  const result = acquireLock(ctx.component);

  if (!result.success) {
    return {
      step: 1,
      name: 'acquire_lock',
      status: 'failed',
      error: result.error,
      duration: Date.now() - startTime,
    };
  }

  ctx.lockAcquired = true;
  return {
    step: 1,
    name: 'acquire_lock',
    status: 'done',
    duration: Date.now() - startTime,
  };
}

/**
 * Step 2: Record rollback point
 */
function step2_recordRollbackPoint(ctx) {
  const startTime = Date.now();
  const result = git.getCurrentCommit(ctx.skillDir);

  if (!result.success) {
    return {
      step: 2,
      name: 'record_commit',
      status: 'failed',
      error: `无法获取当前 commit: ${result.error}`,
      duration: Date.now() - startTime,
    };
  }

  ctx.rollbackPoint = result.output;

  // Write rollback point to file
  const rollbackFile = path.join(ctx.skillDir, '.upgrade-rollback-point');
  fs.writeFileSync(rollbackFile, ctx.rollbackPoint);

  return {
    step: 2,
    name: 'record_commit',
    status: 'done',
    message: ctx.rollbackPoint.substring(0, 7),
    duration: Date.now() - startTime,
  };
}

/**
 * Step 3: Create backup (stash + package-lock.json)
 */
function step3_createBackup(ctx) {
  const startTime = Date.now();

  // Check for local changes
  const changes = git.hasLocalChanges(ctx.skillDir);
  if (!changes.success) {
    return {
      step: 3,
      name: 'backup',
      status: 'failed',
      error: `无法检查本地修改: ${changes.error}`,
      duration: Date.now() - startTime,
    };
  }

  // Stash if there are changes
  if (changes.hasChanges) {
    const stashResult = git.stashChanges(ctx.skillDir);
    if (!stashResult.success) {
      return {
        step: 3,
        name: 'backup',
        status: 'failed',
        error: `无法 stash 本地修改: ${stashResult.error}`,
        duration: Date.now() - startTime,
      };
    }
    ctx.stashName = stashResult.stashName;
    ctx.hadLocalChanges = true;
  }

  // Backup package-lock.json
  const lockFile = path.join(ctx.skillDir, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const backupPath = lockFile + '.backup';
    fs.copyFileSync(lockFile, backupPath);
    ctx.packageLockBackup = backupPath;
  }

  return {
    step: 3,
    name: 'backup',
    status: 'done',
    message: ctx.hadLocalChanges ? 'stash + lock file' : 'lock file only',
    duration: Date.now() - startTime,
  };
}

/**
 * Step 4: Execute pre-upgrade hook
 */
function step4_preUpgradeHook(ctx) {
  const startTime = Date.now();
  const hookPath = path.join(ctx.skillDir, 'hooks', 'pre-upgrade.js');

  if (!fs.existsSync(hookPath)) {
    return {
      step: 4,
      name: 'pre_upgrade_hook',
      status: 'skipped',
      duration: Date.now() - startTime,
    };
  }

  try {
    execSync(`node "${hookPath}"`, {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ZYLOS_COMPONENT: ctx.component,
        ZYLOS_SKILL_DIR: ctx.skillDir,
        ZYLOS_DATA_DIR: ctx.dataDir,
      },
    });
    return {
      step: 4,
      name: 'pre_upgrade_hook',
      status: 'done',
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      step: 4,
      name: 'pre_upgrade_hook',
      status: 'failed',
      error: err.stderr?.trim() || err.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Step 5: Stop PM2 service
 */
function step5_stopService(ctx) {
  const startTime = Date.now();
  const serviceName = `zylos-${ctx.component}`;

  // Check if service exists and is running
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const service = processes.find(p => p.name === serviceName);

    if (!service) {
      return {
        step: 5,
        name: 'stop_service',
        status: 'skipped',
        message: 'no service',
        duration: Date.now() - startTime,
      };
    }

    ctx.serviceWasRunning = service.pm2_env?.status === 'online';

    if (!ctx.serviceWasRunning) {
      return {
        step: 5,
        name: 'stop_service',
        status: 'skipped',
        message: 'not running',
        duration: Date.now() - startTime,
      };
    }

    // Stop the service
    execSync(`pm2 stop ${serviceName} 2>/dev/null`, { stdio: 'pipe' });
    ctx.serviceStopped = true;

    return {
      step: 5,
      name: 'stop_service',
      status: 'done',
      message: serviceName,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    // PM2 might not be available
    return {
      step: 5,
      name: 'stop_service',
      status: 'skipped',
      message: 'pm2 not available',
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Step 6: Git pull
 */
function step6_gitPull(ctx) {
  const startTime = Date.now();
  const result = git.pull(ctx.skillDir);

  if (!result.success) {
    return {
      step: 6,
      name: 'git_pull',
      status: 'failed',
      error: result.error,
      duration: Date.now() - startTime,
    };
  }

  return {
    step: 6,
    name: 'git_pull',
    status: 'done',
    duration: Date.now() - startTime,
  };
}

/**
 * Step 7: npm install
 */
function step7_npmInstall(ctx) {
  const startTime = Date.now();
  const packageJson = path.join(ctx.skillDir, 'package.json');

  if (!fs.existsSync(packageJson)) {
    return {
      step: 7,
      name: 'npm_install',
      status: 'skipped',
      message: 'no package.json',
      duration: Date.now() - startTime,
    };
  }

  try {
    execSync('npm install --omit=dev', {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      step: 7,
      name: 'npm_install',
      status: 'done',
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      step: 7,
      name: 'npm_install',
      status: 'failed',
      error: err.stderr?.trim() || err.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Step 8: Execute post-upgrade hook
 */
function step8_postUpgradeHook(ctx) {
  const startTime = Date.now();
  const hookPath = path.join(ctx.skillDir, 'hooks', 'post-upgrade.js');

  if (!fs.existsSync(hookPath)) {
    return {
      step: 8,
      name: 'post_upgrade_hook',
      status: 'skipped',
      duration: Date.now() - startTime,
    };
  }

  try {
    execSync(`node "${hookPath}"`, {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ZYLOS_COMPONENT: ctx.component,
        ZYLOS_SKILL_DIR: ctx.skillDir,
        ZYLOS_DATA_DIR: ctx.dataDir,
      },
    });
    return {
      step: 8,
      name: 'post_upgrade_hook',
      status: 'done',
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      step: 8,
      name: 'post_upgrade_hook',
      status: 'failed',
      error: err.stderr?.trim() || err.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Step 9: Start service and verify
 */
function step9_startAndVerify(ctx) {
  const startTime = Date.now();
  const serviceName = `zylos-${ctx.component}`;

  // Only restart if service was running before
  if (!ctx.serviceWasRunning) {
    return {
      step: 9,
      name: 'start_and_verify',
      status: 'skipped',
      message: 'service was not running',
      duration: Date.now() - startTime,
    };
  }

  try {
    // Start the service
    execSync(`pm2 start ${serviceName} 2>/dev/null`, { stdio: 'pipe' });

    // Brief wait for service to initialize
    execSync('sleep 2');

    // Verify service is running
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const service = processes.find(p => p.name === serviceName);

    if (!service || service.pm2_env?.status !== 'online') {
      return {
        step: 9,
        name: 'start_and_verify',
        status: 'failed',
        error: '服务启动验证失败',
        duration: Date.now() - startTime,
      };
    }

    ctx.serviceStopped = false; // Service is now running
    return {
      step: 9,
      name: 'start_and_verify',
      status: 'done',
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      step: 9,
      name: 'start_and_verify',
      status: 'failed',
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Rollback on failure
 */
function rollback(ctx) {
  const results = [];

  // Stop service if we started it during upgrade
  if (ctx.serviceStopped === false && ctx.serviceWasRunning) {
    try {
      execSync(`pm2 stop zylos-${ctx.component} 2>/dev/null || true`, { stdio: 'pipe' });
    } catch {}
  }

  // Reset to rollback point
  if (ctx.rollbackPoint) {
    const resetResult = git.resetHard(ctx.skillDir, ctx.rollbackPoint);
    results.push({
      action: 'git_reset',
      success: resetResult.success,
      error: resetResult.error,
    });
  }

  // Restore package-lock.json
  if (ctx.packageLockBackup && fs.existsSync(ctx.packageLockBackup)) {
    try {
      const lockFile = path.join(ctx.skillDir, 'package-lock.json');
      fs.copyFileSync(ctx.packageLockBackup, lockFile);
      fs.unlinkSync(ctx.packageLockBackup);

      // Re-run npm install with restored lock
      execSync('npm install --omit=dev', {
        cwd: ctx.skillDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      results.push({ action: 'restore_dependencies', success: true });
    } catch (err) {
      results.push({ action: 'restore_dependencies', success: false, error: err.message });
    }
  }

  // Pop stash
  if (ctx.hadLocalChanges) {
    const popResult = git.popStash(ctx.skillDir);
    results.push({
      action: 'stash_pop',
      success: popResult.success,
      error: popResult.error,
    });
  }

  // Restart service if it was running
  if (ctx.serviceWasRunning) {
    try {
      execSync(`pm2 restart zylos-${ctx.component} 2>/dev/null || true`, { stdio: 'pipe' });
      results.push({ action: 'restart_service', success: true });
    } catch (err) {
      results.push({ action: 'restart_service', success: false, error: err.message });
    }
  }

  // Release lock
  if (ctx.lockAcquired) {
    releaseLock(ctx.component);
    results.push({ action: 'release_lock', success: true });
  }

  // Clean up rollback point file
  const rollbackFile = path.join(ctx.skillDir, '.upgrade-rollback-point');
  if (fs.existsSync(rollbackFile)) {
    try {
      fs.unlinkSync(rollbackFile);
    } catch {}
  }

  return results;
}

/**
 * Run the full 9-step upgrade
 * @param {string} component - Component name
 * @param {object} options - Options (jsonOutput, etc.)
 * @returns {object} Upgrade result
 */
async function runUpgrade(component, options = {}) {
  const ctx = createContext(component);

  // Get versions before upgrade
  const localVersion = git.getLocalVersion(ctx.skillDir);
  if (localVersion.success) {
    ctx.from = localVersion.version;
  }

  const steps = [
    step1_acquireLock,
    step2_recordRollbackPoint,
    step3_createBackup,
    step4_preUpgradeHook,
    step5_stopService,
    step6_gitPull,
    step7_npmInstall,
    step8_postUpgradeHook,
    step9_startAndVerify,
  ];

  let failedStep = null;

  for (const stepFn of steps) {
    const result = stepFn(ctx);
    ctx.steps.push(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  // If failed, rollback
  if (failedStep) {
    const rollbackResults = rollback(ctx);
    return {
      action: 'upgrade',
      component,
      success: false,
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: failedStep.error,
      steps: ctx.steps,
      rollback: {
        performed: true,
        steps: rollbackResults,
      },
    };
  }

  // Success - get new version
  const newVersion = git.getLocalVersion(ctx.skillDir);
  if (newVersion.success) {
    ctx.to = newVersion.version;
  }

  // Update components.json
  const components = loadComponents();
  if (components[component]) {
    components[component].version = ctx.to || components[component].version;
    components[component].upgradedAt = new Date().toISOString();
    saveComponents(components);
  }

  // Release lock
  releaseLock(component);

  // Clean up rollback point file
  const rollbackFile = path.join(ctx.skillDir, '.upgrade-rollback-point');
  if (fs.existsSync(rollbackFile)) {
    try {
      fs.unlinkSync(rollbackFile);
    } catch {}
  }

  // Clean up package-lock backup
  if (ctx.packageLockBackup && fs.existsSync(ctx.packageLockBackup)) {
    try {
      fs.unlinkSync(ctx.packageLockBackup);
    } catch {}
  }

  return {
    action: 'upgrade',
    component,
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    stashExists: ctx.hadLocalChanges,
  };
}

module.exports = {
  checkForUpdates,
  runUpgrade,
  rollback,
};
