import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCoreModule } from './core-modules.js';

const { SUPPORTED_RUNTIMES, getRuntime } = await loadCoreModule('runtime/index.js');

const execute = promisify(execFile);

// Share concurrent timer/action refreshes; failed commands retain the last value.
export function createInstalledVersionReader({
  run = execute,
  probe = async id => (await getRuntime(id)).install.probeVersion({ profile: 'dashboard' }),
} = {}) {
  let pending = null;
  let versions = { zylos: null, ...Object.fromEntries(SUPPORTED_RUNTIMES.map(runtime => [runtime, null])) };
  return function read() {
    if (pending) return pending;
    pending = Promise.all(Object.keys(versions).map(async command => {
      try {
        if (command === 'zylos') {
          const { stdout } = await run(command, ['--version'], { timeout: 5000 });
          return [command, stdout.trim()];
        }
        const result = await probe(command);
        return [command, result.installed && !result.probeFailed ? result.version : versions[command]];
      } catch { return [command, versions[command]]; }
    })).then(entries => {
      versions = Object.fromEntries(entries);
      return { ...versions };
    }).finally(() => { pending = null; });
    return pending;
  };
}
