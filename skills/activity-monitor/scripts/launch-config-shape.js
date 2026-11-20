// Awaits the runtime factory at module scope. Runtime implementations must not
// reach this module through static imports.
import { loadCoreModule } from './core-modules.js';

const { SUPPORTED_RUNTIMES, getRuntime } = await loadCoreModule('runtime/index.js');
const { UNSUPPORTED } = await loadCoreModule('runtime/contract.js');
const LAUNCH = new Map(await Promise.all(
  SUPPORTED_RUNTIMES.map(async id => [id, (await getRuntime(id)).launch]),
));
/** Validate an observed snapshot without invoking the runtime executable. */
export function validLaunchConfigSnapshot(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const launch = LAUNCH.get(config.runtime);
  if (!launch) return false;
  if (config.mode === 'default') return Object.keys(config).every(key => ['runtime', 'mode'].includes(key));
  if (launch.efforts === UNSUPPORTED) return false;
  if (config.mode !== 'override' || Object.keys(config).some(key => !['runtime', 'mode', 'model', 'effort'].includes(key))) return false;
  if (![config.model, config.effort].every(value => typeof value === 'string' && value.trim() && !value.includes('\0'))) return false;
  return launch.efforts.includes(config.effort);
}
