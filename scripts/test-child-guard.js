import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const liveDirectory = canonicalPath(path.join(os.userInfo().homedir, 'zylos'));
const preload = `--import=${JSON.stringify(new URL('./test-child-preload.js', import.meta.url).href)}`;

// Resolve existing ancestors too: a not-yet-created leaf can live below a symlink.
function canonicalPath(directory) {
  let existing = path.resolve(directory);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

export function assertTestChildEnvironment(env = process.env, cwd = process.cwd()) {
  const directory = env.ZYLOS_DIR || path.join(env.HOME || os.userInfo().homedir, 'zylos');
  const resolved = canonicalPath(path.resolve(cwd instanceof URL ? fileURLToPath(cwd) : cwd, directory));
  const relative = path.relative(liveDirectory, resolved);
  assert(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    'Test child ZYLOS_DIR points at the live instance');
}

function withPreload(options = {}) {
  const env = { ...(options.env || process.env) };
  assertTestChildEnvironment(env, options.cwd || process.cwd());
  if (!env.NODE_OPTIONS?.includes(preload)) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, preload].filter(Boolean).join(' ');
  }
  return { ...options, env };
}

export function installTestChildGuard() {
  const originals = new Map();
  // Cover public launch APIs, including sync methods which bypass ChildProcess.spawn.
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    originals.set(name, original);
    function guardedArguments(args) {
      const index = args.findIndex((arg, i) => i > 0 && arg !== null && typeof arg === 'object' && !Array.isArray(arg));
      if (index >= 0) args[index] = withPreload(args[index]);
      else {
        const callback = typeof args.at(-1) === 'function' ? args.length - 1 : args.length;
        if (args[callback - 1] === null || args[callback - 1] === undefined) args[callback - 1] = withPreload();
        else args.splice(callback, 0, withPreload());
      }
      return args;
    }
    childProcess[name] = function guardedChild(...args) {
      return Reflect.apply(original, this, guardedArguments(args));
    };
    if (original[promisify.custom]) {
      childProcess[name][promisify.custom] = function guardedPromise(...args) {
        return Reflect.apply(original[promisify.custom], this, guardedArguments(args));
      };
    }
  }
  syncBuiltinESMExports();
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = withPreload().env.NODE_OPTIONS;
  return () => {
    for (const [name, original] of originals) childProcess[name] = original;
    syncBuiltinESMExports();
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  };
}
