import {createRequire} from 'node:module';
import path from 'node:path';
const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');

// Presentation only: uncertainty must retain the existing recovery guidance.
export function runningUpgradeNotice(root, { maintenance: m = maintenance, found } = {}) {
  try {
    found ??= m.discover(root);
    if (found.diagnostics.length || found.candidates.length !== 1 || !m.canRecognizeProcesses()) return null;
    const owner = m.read(path.join(found.candidates[0].dir, 'controller.json'));
    if (!m.alive(owner)) return null;
    return {error:'Another Core upgrade is still running.', next:'Wait for it to finish, then retry the upgrade.'};
  } catch { return null; }
}

export function isClosedRecovery(found, m = maintenance) {
  return maintenance.isClosedRecovery(found,m);
}
export function recoveryNext(found, m = maintenance, fallback) {
  return maintenance.recoveryNext(found,m,fallback);
}
// Use the installed caller's helper, not a possibly older frozen maintenance.
export function recoverBeforeUpgrade(root, deps = {}) {
  return maintenance.recoverBeforeUpgrade(root,deps);
}
