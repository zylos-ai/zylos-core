import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function hasRecoveryMaterials(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    for (const relative of ['.zylos', '.zylos/upgrade', '.backup', '.backup/self-upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' && relative !== '.backup' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    for (const relative of ['.zylos/upgrade/active.json']) {
      if (present(path.join(root, relative))) return true;
    }
    const active = path.join(root, '.backup/self-upgrade');
    return !!present(active) && fs.readdirSync(active).length > 0;
  } catch {
    return true;
  }
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
export function discoverUpgradeContext(root) {
  try {
    root = fs.realpathSync(root);
    if (!hasRecoveryMaterials(root)) return { active: false, blocked: false };
    const directory = path.join(root, '.zylos', 'upgrade');
    const entry = path.join(directory, 'bootstrap.cjs');
    for (const [parent, shared] of [[path.join(root, '.zylos'), true], [directory, false]]) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          (process.getuid && stat.uid !== process.getuid()) || (!shared && (stat.mode & 0o022))) {
        throw Error('untrusted stable upgrade discovery directory');
      }
    }
    for (const [file, isDirectory] of [
      [directory, true],
      ...['bootstrap.cjs', 'maintenance.cjs'].map(name => [path.join(directory, name), false]),
    ]) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
          (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
        throw Error('untrusted stable upgrade discovery material');
      }
    }
    return require(entry).bootstrap(root);
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
