import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCleanEnv, buildCompatEnv, loadRuntimeEnvManifest } from './tmux-env.js';
import { buildKickPrompt } from './kick-prompt.js';

export function adapterError(code, message = code, cause) {
  return Object.assign(new Error(message), {code}, cause === undefined ? {} : {cause});
}
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
  if (!config || config.runtime !== runtime || !['default','override'].includes(config.mode)) throw adapterError('MODEL_CONFIG_REJECTED');
  const keys = config.mode === 'default' ? ['runtime','mode'] : ['runtime','mode','model','effort'];
  if (Object.keys(config).some(k => !keys.includes(k))) throw adapterError('MODEL_CONFIG_REJECTED');
  if (config.mode === 'override') {
    if (![config.model, config.effort].every(v => typeof v === 'string' && v.trim() && !v.includes('\0'))) throw adapterError('MODEL_CONFIG_REJECTED');
    const efforts = runtime === 'claude' ? ['low','medium','high','max'] : ['none','minimal','low','medium','high','xhigh'];
    if (!efforts.includes(config.effort) || !/(?:^|\s)--model(?:\s|[,=])/m.test(help) || (runtime === 'claude' && !/(?:^|\s)--effort(?:\s|[,=])/m.test(help))) throw adapterError('MODEL_CONFIG_REJECTED');
  }
  return true;
}
export function buildRuntimeArgs(runtime, config, {root, help = '', bypassPermissions = true} = {}) {
  const server = path.join(root, '.claude/skills/zylos-memory/scripts/memory-mcp-server.js');
  const args = [];
  if (runtime === 'claude') {
    if (bypassPermissions) args.push('--dangerously-skip-permissions');
    if (config.mode === 'override') args.push('--model', config.model, '--effort', config.effort);
    args.push('--mcp-config', JSON.stringify({mcpServers:{'zylos-memory':{type:'stdio', command:'node', args:[server]}}}));
  } else {
    if (/(?:^|\s)--no-daemon(?:\s|$)/m.test(help)) args.push('--no-daemon');
    if (bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (config.mode === 'override') args.push('--model', config.model, '-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`);
    for (const [key,value] of Object.entries({command:'node', args:[server], env_vars:['ZYLOS_SESSION_GROUP','ZYLOS_RUN_ID','ZYLOS_DIR']})) args.push('-c', `mcp_servers.zylos-memory.${key}=${JSON.stringify(value)}`);
    args.push(buildKickPrompt());
  }
  return args;
}
/** Preserve native Claude auth precedence using the launch's isolated HOME. */
export function hasNativeClaudeAuth(command, env) {
  if (env.HOME && !env.CLAUDE_CONFIG_DIR) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(env.HOME, '.claude', '.credentials.json'), 'utf8'));
      if (data?.claudeAiOauth?.refreshToken) return true;
    } catch { /* Missing/unreadable credentials may still use native status. */ }
  }
  try {
    const nativeEnv = { ...env };
    delete nativeEnv.ANTHROPIC_API_KEY;
    delete nativeEnv.CLAUDE_CODE_OAUTH_TOKEN;
    const status = JSON.parse(execFileSync(command, ['auth', 'status'], {
      env:nativeEnv, cwd:env.ZYLOS_DIR, encoding:'utf8', timeout:10000, killSignal:'SIGKILL', stdio:'pipe',
    }));
    return status?.loggedIn === true && status?.authMethod === 'claude.ai';
  } catch { return false; }
}
export function launchEnvironment(root, processEnv = process.env) {
  const dotenvVars = {};
  try {
    for (const line of fs.readFileSync(path.join(root,'.env'),'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) dotenvVars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const {env} = dotenvVars.ZYLOS_CLEAN_ENV === 'false'
    ? buildCompatEnv({processEnv, dotenvVars})
    : buildCleanEnv({processEnv, dotenvVars, manifest:loadRuntimeEnvManifest(root), uid:process.getuid?.()});
  for (const key of ['ZYLOS_RUN_ID','ZYLOS_SESSION_GROUP','ZYLOS_MODEL_CONFIG','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT']) delete env[key];
  env.ZYLOS_DIR = root;
  return env;
}
/** Shell exec works on the minimum Node release too: no resident Node parent. */
export function writeSessionLaunchScript({command,args,env,root,multi}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-session-'));
  fs.chmodSync(dir,0o700);
  const file = path.join(dir,'launch.sh');
  const bindings = Object.entries(env).map(([k,v]) => shellQuote(`${k}=${v}`));
  bindings.push('"ZYLOS_RUN_ID=$ZYLOS_RUN_ID"','"ZYLOS_MODEL_CONFIG=$ZYLOS_MODEL_CONFIG"');
  if (multi) bindings.push('"ZYLOS_SESSION_GROUP=$ZYLOS_SESSION_GROUP"');
  const script = `#!/bin/sh\nset -eu\ncd ${shellQuote(root)}\nrm -- ${shellQuote(file)}\nrmdir -- ${shellQuote(dir)}\nexec env -i ${bindings.join(' ')} ${[command,...args].map(shellQuote).join(' ')}\n`;
  fs.writeFileSync(file,script,{mode:0o600});
  return {file, cleanup() { fs.rmSync(dir,{recursive:true,force:true}); }};
}
export function runtimeHelp(command, env = process.env) {
  try { return execFileSync(command,['--help'],{env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL',stdio:'pipe'}); }
  catch (e) { throw adapterError('LAUNCH_FAILED', 'Runtime capability query failed', e.code === 'ETIMEDOUT' ? 'timeout':'error'); }
}
