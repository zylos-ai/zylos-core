import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { recoverBeforeUpgrade } from '../upgrade-discovery.js';
const require = createRequire(import.meta.url);
const maintenance = require('../upgrade-maintenance.cjs');

function hasTransactionHistory(root) {
  for (const relative of ['.backup', '.backup/self-upgrade']) {
    let stat;
    try { stat = fs.lstatSync(path.join(root, relative)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  const directory = path.join(root, '.backup/self-upgrade');
  const entries = fs.readdirSync(directory, {withFileTypes:true});
  if (entries.length > 10000) throw Error('upgrade startup transaction scan budget exhausted');
  const active = maintenance.hasRecoveryMaterials(root);
  // Historical backups without this transaction-runner protocol cannot
  // authorize recovery during ordinary startup.
  return entries.some(entry => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const dir = path.join(directory, entry.name);
    const publishedRecovery = ['runner.cjs', 'maintenance.cjs', 'installer.cjs'].some(name => {
      try { fs.lstatSync(path.join(dir, name)); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    try {
      const journal = maintenance.transaction(root, dir);
      return (journal.recoveryHashes || publishedRecovery) && (
        !maintenance.terminalValid(journal) || !journal.cleanup.complete && !maintenance.legacyUpgradeHistory(journal) ||
        journal.installerExitUnconfirmed || journal.finalizerExitUnconfirmed ||
        journal.installerStarted && !journal.installerExitConfirmed ||
        journal.finalizerStarted && !journal.finalizerExitConfirmed ||
        journal.terminalServicesStopped || active
      );
    } catch { return publishedRecovery; }
  });
}

// Stable bootstrap discovery follows the active marker. The separate history
// scan also catches transaction-local publication interrupted before it exists.
function hasRecoveryMaterials(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    for (const relative of ['.zylos', '.zylos/upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    return !!present(path.join(root, '.zylos/upgrade/active.json'));
  } catch { return true; }
}

export function upgradeDiscoveryFailure() {
  return {
    active: true,
    blocked: true,
    recovery_required: true,
    prompt: 'SYSTEM RECOVERY TASK: Upgrade discovery failed. Keep normal C4/database access isolated. Use only the fixed file-only upgrade status entry after verifying its ownership and permissions. Preserve transaction materials; report recovery_required if trusted discovery remains unavailable. Do not query C4 or execute journal command strings.',
  };
}

// Validate every module imported during discovery before executing any code.
// The deployment owner controls these files; links and writable files cannot
// authorize startup code, even when discovery itself would throw safely.
export function discoverUpgradeContext(root, {recover = true} = {}) {
  try {
    root = fs.realpathSync(root);
    if (hasTransactionHistory(root)) {
      const found = maintenance.discover(root);
      const failed = () => ({...upgradeDiscoveryFailure(),
        blocked:maintenance.hasRecoveryMaterials(root) ? maintenance.discoverActive(root).blocked : true});
      if (found.diagnostics.length || found.candidates.length !== 1) return failed();
      if (!recover) return {active:true, ...found};
      const controller = path.join(found.candidates[0].dir, 'controller.json');
      if (maintenance.canRecognizeProcesses() && fs.existsSync(controller) && maintenance.alive(maintenance.read(controller))) {
        return {...upgradeDiscoveryFailure(), blocked:found.blocked, controllerAlive:true, observing:true, recovery_required:false};
      }
      // A transaction can be published before its stable bootstrap or active
      // marker. Its verified recovery closure owns interrupted installation.
      // Reuse this discovery for delegation; the helper's final read still
      // checks durable state after the recovery child exits.
      let initialDiscovery = true;
      const recoveryMaintenance = {...maintenance, discover: deployment => {
        if (initialDiscovery) { initialDiscovery = false; return found; }
        return maintenance.discover(deployment);
      }};
      try { recoverBeforeUpgrade(root, {maintenance:recoveryMaintenance}); }
      catch { return failed(); }
      return {active:false, blocked:false};
    }
    if (!hasRecoveryMaterials(root)) return { active: false, blocked: false };
    const directory = path.join(root, '.zylos', 'upgrade');
    const entry = path.join(directory, 'bootstrap.cjs');
    for (const parent of [path.join(root, '.zylos'), directory]) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw Error('untrusted stable upgrade discovery directory');
      }
    }
    for (const [file, isDirectory] of [
      [directory, true],
      ...['bootstrap.cjs', 'maintenance.cjs'].map(name => [path.join(directory, name), false]),
    ]) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) {
        throw Error('untrusted stable upgrade discovery material');
      }
    }
    // Revalidate and load the current stable generation on each discovery.
    // These paths can be replaced between upgrades in the same process.
    delete require.cache[entry];
    delete require.cache[path.join(directory, 'maintenance.cjs')];
    return require(entry).bootstrap(root, {status:!recover});
  } catch {
    return upgradeDiscoveryFailure();
  }
}

export function upgradeStartupPrompt(root) {
  const context = discoverUpgradeContext(root);
  return context.blocked || (context.active && !context.controllerAlive) ? context.prompt : null;
}

export function shellArgument(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function applyUpgradePrompt(args, prompt, promptIndex, { append = false } = {}) {
  const next = [...args];
  if (!prompt) return next;
  if (promptIndex !== undefined) {
    if (!Number.isInteger(promptIndex) || promptIndex < 0 || promptIndex >= next.length) {
      throw new Error('invalid runtime startup prompt index');
    }
    next[promptIndex] = append && !next[promptIndex].endsWith(prompt)
      ? next[promptIndex] + '\n\n' + prompt : append ? next[promptIndex] : prompt;
  } else next.push(prompt);
  return next;
}
