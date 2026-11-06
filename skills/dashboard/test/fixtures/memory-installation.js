import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const coreRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Copy actual entry points, with all mutable state confined to the fixture. */
export function installMemoryScripts(zylosDir) {
  const skills = path.join(zylosDir, '.claude', 'skills');
  const target = path.join(skills, 'zylos-memory', 'scripts');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(skills, 'zylos-memory', 'package.json'), '{"type":"module"}');
  const source = path.join(coreRoot, 'skills', 'zylos-memory', 'scripts');
  for (const name of fs.readdirSync(source)) {
    if (name.endsWith('.js') && fs.statSync(path.join(source, name)).isFile()) {
      fs.copyFileSync(path.join(source, name), path.join(target, name));
    }
  }
  const bridge = path.join(skills, 'comm-bridge', 'scripts');
  fs.mkdirSync(bridge, { recursive: true });
  fs.writeFileSync(path.join(skills, 'comm-bridge', 'package.json'), '{"type":"module"}');
  for (const name of ['core-config-loader.js', 'c4-query-format.js', 'c4-session-group.js']) {
    fs.copyFileSync(path.join(coreRoot, 'skills', 'comm-bridge', 'scripts', name), path.join(bridge, name));
  }
  return path.join(target, 'memory-write.js');
}

export function memoryTestEnv(zylosDir) {
  const env = { ...process.env, ZYLOS_DIR: zylosDir, ZYLOS_PACKAGE_ROOT: coreRoot };
  for (const key of ['TMUX', 'ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const [key, name] of Object.entries({ HOME: 'h', PM2_HOME: 'p', TMPDIR: 't', TMUX_TMPDIR: 'm' })) {
    env[key] = path.join(zylosDir, name);
    fs.mkdirSync(env[key], { recursive: true });
  }
  return env;
}

/** Prefer runner isolation; only shorten roots when a private tmux socket would
 * exceed Unix socket limits (104 bytes on macOS). The fallback is still a new,
 * fixture-owned root with isolated HOME/ZYLOS_DIR/PM2_HOME and explicit cleanup. */
export function memoryTempRoot(prefix) {
  const candidate = path.join(os.tmpdir(), prefix);
  const socket = path.join(candidate + 'XXXXXX', 'm', 'tmux-4294967295', 'default');
  return fs.mkdtempSync(Buffer.byteLength(socket) < 100 ? candidate : path.join('/tmp', prefix));
}
