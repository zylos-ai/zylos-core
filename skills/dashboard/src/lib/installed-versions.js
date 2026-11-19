import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCoreModule } from './core-modules.js';

const { SUPPORTED_RUNTIMES } = await loadCoreModule('runtime/descriptors.js');

const execute = promisify(execFile);

// Share concurrent timer/action refreshes; failed commands retain the last value.
export function createInstalledVersionReader({ run = execute } = {}) {
  let pending = null;
  let versions = { zylos: null, ...Object.fromEntries(SUPPORTED_RUNTIMES.map(runtime => [runtime, null])) };
  return function read() {
    if (pending) return pending;
    pending = Promise.all(Object.keys(versions).map(async command => {
      try {
        const { stdout } = await run(command, ['--version'], { timeout: 5000 });
        const raw = stdout.trim();
        if (command === 'agy') return [command, raw.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? null];
        return [command, command === 'zylos' ? raw : raw.replace(/^codex-cli\s+/, '').replace(/\s.*$/, '')];
      } catch { return [command, versions[command]]; }
    })).then(entries => {
      versions = Object.fromEntries(entries);
      return { ...versions };
    }).finally(() => { pending = null; });
    return pending;
  };
}
