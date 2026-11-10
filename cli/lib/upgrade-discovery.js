import {createRequire} from 'node:module';
const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');

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
