import { UNSUPPORTED } from './contract.js';
import { removeOwnedTree } from '../../../skills/comm-bridge/scripts/remove-owned-tree.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseDotenv } from 'dotenv';
import { buildCleanEnv, buildCompatEnv, loadRuntimeEnvManifest } from './tmux-env.js';
import { adapterError } from './tmux-protocol.js';
export { adapterError } from './tmux-protocol.js';
export const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function runtimeExecutable(runtime, env = process.env) {
  const name = env[`${runtime.toUpperCase()}_BIN`] || runtime;
  const candidates = path.isAbsolute(name) ? [name] : (env.PATH || '').split(path.delimiter).map(p => path.resolve(p, name));
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  throw adapterError('RUNTIME_NOT_INSTALLED');
}
export function validateLaunchConfig(runtime, config, help = '') {
  if (!config || config.runtime !== runtime.id || !['default','override'].includes(config.mode)) throw adapterError('MODEL_CONFIG_REJECTED');
  const keys = config.mode === 'default' ? ['runtime','mode'] : ['runtime','mode','model','effort'];
  if (Object.keys(config).some(k => !keys.includes(k))) throw adapterError('MODEL_CONFIG_REJECTED');
  if (config.mode === 'override') {
    const { efforts, overrideHelpFlags } = runtime.launch;
    if (efforts === UNSUPPORTED) throw adapterError('MODEL_CONFIG_REJECTED');
    if (![config.model, config.effort].every(v => typeof v === 'string' && v.trim() && !v.includes('\0'))) throw adapterError('MODEL_CONFIG_REJECTED');
    if (!efforts.includes(config.effort) || overrideHelpFlags.some(flag => {
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`(?:^|\\s)${escaped}(?:\\s|[,=])`, 'm').test(help);
    })) throw adapterError('MODEL_CONFIG_REJECTED');
  }
  return true;
}
export function memoryMcpServerPath(root) {
  return path.join(root, '.claude/skills/zylos-memory/scripts/memory-mcp-server.js');
}
/**
 * Read <root>/.env with the shared dotenv grammar, including exports, comments
 * and colon assignments. Later assignments win. Empty when absent.
 */
export function readLaunchDotenv(root) {
  let dotenvVars = {};
  try {
    dotenvVars = parseDotenv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return dotenvVars;
}
export function launchEnvironment(root, processEnv = process.env, { runtimeEnv } = {}) {
  const dotenvVars = readLaunchDotenv(root);
  const {env} = dotenvVars.ZYLOS_CLEAN_ENV === 'false'
    ? buildCompatEnv({processEnv, dotenvVars})
    : buildCleanEnv({processEnv, dotenvVars, manifest:loadRuntimeEnvManifest(root), uid:process.getuid?.()});
  if (runtimeEnv) {
    Object.assign(env, runtimeEnv.fixed);
    for (const key of runtimeEnv.fromDotenv) {
      if (dotenvVars[key]) env[key] = dotenvVars[key];
    }
    for (const key of runtimeEnv.fromDotenvOrProcess) {
      const value = Object.hasOwn(dotenvVars, key) ? dotenvVars[key] : processEnv[key];
      if (value) env[key] = value;
      else delete env[key];
    }
  }
  for (const key of ['ZYLOS_RUN_ID','ZYLOS_SESSION_GROUP','ZYLOS_MODEL_CONFIG','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT']) delete env[key];
  env.ZYLOS_DIR = root;
  return env;
}
/** Shell exec works on the minimum Node release too: no resident Node parent. */
export function writeSessionLaunchScript({command,args,env,root,multi}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(temporaryRoot, 'zylos-session-'));
  fs.chmodSync(dir,0o700);
  const file = path.join(dir,'launch.sh');
  const bindings = Object.entries(env).map(([k,v]) => shellQuote(`${k}=${v}`));
  bindings.push('"ZYLOS_RUN_ID=$ZYLOS_RUN_ID"','"ZYLOS_MODEL_CONFIG=$ZYLOS_MODEL_CONFIG"');
  // Group binding also applies to native single's Origin (the caller supplies it).
  if (multi) bindings.push('"ZYLOS_SESSION_GROUP=$ZYLOS_SESSION_GROUP"');
  const script = `#!/bin/sh\nset -eu\ncd ${shellQuote(root)}\nrm -- ${shellQuote(file)}\nrmdir -- ${shellQuote(dir)}\nexec env -i ${bindings.join(' ')} ${[command,...args].map(shellQuote).join(' ')}\n`;
  fs.writeFileSync(file,script,{mode:0o600});
  return {file, cleanup() {
    // launch.sh removes only itself and its directory. Retry once if its unlink
    // wins the race, so the remaining empty directory is still removed. A
    // second ENOENT means the shell also finished removing that directory.
    try { removeOwnedTree(temporaryRoot, dir); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { removeOwnedTree(temporaryRoot, dir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }};
}
export function runtimeHelp(command, env = process.env) {
  try { return execFileSync(command,['--help'],{env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL',stdio:'pipe'}); }
  catch (e) { throw adapterError('LAUNCH_FAILED', 'Runtime capability query failed', e.code === 'ETIMEDOUT' ? 'timeout':'error'); }
}
export async function runtimeHelpAsync(command, env = process.env, { timeoutMs = 10000 } = {}) {
  try {
    const { stdout } = await promisify(execFile)(command, ['--help'], {
      env, encoding:'utf8', timeout:timeoutMs, killSignal:'SIGKILL',
    });
    return stdout;
  } catch (error) {
    throw adapterError('LAUNCH_FAILED', 'Runtime capability query failed', error.killed ? 'timeout' : 'error');
  }
}
