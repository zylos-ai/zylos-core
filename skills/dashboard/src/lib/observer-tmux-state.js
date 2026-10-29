import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ObserverContainmentError } from './observer-containment-error.js';

export { ObserverContainmentError };
export const runCommand = promisify(execFile);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const socketParent = () => fs.realpath('/tmp');
export const finalName = /^g-\d+-[0-9a-f]{32}$/;
export function failure(code, message) { return new ObserverContainmentError(code, message); }
export async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function privatePath(file, type = 'directory') {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (type === 'directory' ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid() || (stat.mode & 0o077) || (type === 'file' && stat.size > 128 * 1024)) {
    throw failure('unsafe_runtime_state', `Unsafe Observer ${type}: ${file}`);
  }
  return stat;
}
export async function privateParents(root) {
  // Existing parents may be shared, but none may redirect managed paths.
  let cursor = path.resolve(root);
  while (cursor !== path.dirname(cursor)) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw failure('unsafe_runtime_state', 'Symlink in Observer path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = path.dirname(cursor);
  }
}
export async function mkdirPrivate(root) {
  await privateParents(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await privatePath(root);
}
export async function syncDirectory(root) {
  const handle = await fs.open(root, 'r');
  try { await handle.sync(); } catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle.close(); }
}
export async function writeAtomic(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}
export async function readJson(file) {
  await privatePath(file, 'file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export function privateEnvironment(state) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === 'TMUX' || key.startsWith('ZELLIJ') || key.startsWith('XDG_')) delete env[key];
  const root = state.root;
  return { ...env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_RUNTIME_DIR: state.socketRoot,
    XDG_CONFIG_DIRS: path.join(root, 'config-dirs'), XDG_DATA_DIRS: path.join(root, 'data-dirs'),
    ZELLIJ_CONFIG_DIR: path.join(root, 'config'), ZELLIJ_CACHE_DIR: path.join(root, 'cache'),
    ZELLIJ_DATA_DIR: path.join(root, 'data'), ZELLIJ_SOCKET_DIR: state.socketRoot,
    TMPDIR: `${root}/tmp/`, TMP: `${root}/tmp`, TEMP: `${root}/tmp`, TERM: 'xterm-256color' };
}
export function zellijArgs(state, ...args) {
  return ['--data-dir', path.join(state.root, 'data'), '--config', state.configFile, ...args];
}
export function targetArgs(state, ...args) {
  return ['-N', ...(state.tmuxSocket ? ['-S', state.tmuxSocket] : []), ...args];
}
export function outerArgs(state, ...args) { return ['-N', '-S', state.outerSocket, ...args]; }
export async function command(file, args, options = {}) {
  return runCommand(file, args, { encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 3000, ...options, env: { ...(options.env || process.env), LC_ALL: 'C' } });
}
export async function processSnapshot(exec = command) {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,stat=,command='], { maxBuffer: 16 * 1024 * 1024 });
  const result = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+(.*)$/);
    if (!match) throw failure('process_query_failed', 'Cannot parse process inventory');
    const [, pid, ppid, start, status, cmd] = match;
    result.push({ pid: Number(pid), ppid: Number(ppid), start, status, command: cmd });
  }
  return result;
}
export async function identity(pid, snapshot = null) {
  const entry = (snapshot || await processSnapshot()).find((item) => item.pid === pid);
  if (!entry) return null;
  if (process.platform === 'linux') {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      entry.start = `${(await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${fields[19]}`;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return entry;
}
export async function sameProcess(record, snapshot) {
  if (!record) return false;
  const current = await identity(record.pid, snapshot);
  return !!current && current.start === record.start;
}
export const tmuxConfigText = 'set-option -g remain-on-exit on\nset-option -g exit-empty off\n';
// The observer server runs with LC_ALL=C (see command()), which tmux would
// otherwise treat as a non-UTF-8 client and render every non-ASCII character
// as "_". -u keeps the read-only view faithful without changing that locale.
export function innerAttachArgs(state) {
  return ['-u', ...targetArgs(state, 'attach-session', '-r', '-t', `=${state.target}`)];
}
export function fixedLayout(state) {
  return `layout {\n  pane command=${JSON.stringify(state.tmuxPath)} focus=true {\n    args ${innerAttachArgs(state).map((value) => JSON.stringify(value)).join(' ')}\n    close_on_exit false\n    start_suspended false\n  }\n}\n`;
}
export async function validateState(root) {
  if (!finalName.test(path.basename(root))) throw failure('unsafe_runtime_state', 'Worker requires a final generation');
  await privateParents(root);
  await privatePath(root);
  const state = await readJson(path.join(root, 'state.json'));
  if (state.schema !== 2) throw failure('legacy_containment_state', 'Native Observer state requires old-version recovery');
  if ((state.startupRecovery !== undefined && state.startupRecovery !== 1) || !Number.isSafeInteger(state.generation) || state.generation < 0 || !/^[0-9a-f]{32}$/.test(state.nonce) ||
      path.basename(root) !== `g-${state.generation}-${state.nonce}` || state.root !== root ||
      state.socketRoot !== path.join(await socketParent(), `zobs2-${state.nonce.slice(0, 16)}`) ||
      state.outerSocket !== path.join(state.socketRoot, 'tmux') ||
      state.sessionName !== `observer-${state.nonce.slice(0, 16)}` ||
      !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 ||
      !['claude-main', 'codex-main'].includes(state.target) ||
      typeof state.binaryPath !== 'string' || !path.isAbsolute(state.binaryPath) ||
      typeof state.tmuxPath !== 'string' || !state.tmuxPath ||
      (state.tmuxSocket !== null && (typeof state.tmuxSocket !== 'string' || !path.isAbsolute(state.tmuxSocket))) ||
      !validRole(state.parent) ||
      !state.hashes || ['binary', 'layoutFile', 'tmuxConfig', 'configFile'].some((key) => !/^[a-f0-9]{64}$/.test(state.hashes[key])) ||
      state.platform !== process.platform || state.arch !== process.arch) throw failure('unsafe_runtime_state', 'Invalid Observer metadata');
  for (const [key, name] of Object.entries({ layoutFile: 'readonly-tmux.kdl', tmuxConfig: 'tmux.conf', configFile: 'zellij.kdl', tokenFile: 'read-only-token' })) {
    if (state[key] !== path.join(root, name)) throw failure('unsafe_runtime_state', 'Invalid Observer file path');
    if (key !== 'tokenFile') {
      await privatePath(state[key], 'file');
      if (digest(await fs.readFile(state[key])) !== state.hashes?.[key]) throw failure('unsafe_runtime_state', 'Observer config changed');
    }
  }
  await privateParents(state.binaryPath);
  const binaryStat = await fs.lstat(state.binaryPath);
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || binaryStat.uid !== process.getuid() ||
      !(binaryStat.mode & 0o111) || (binaryStat.mode & 0o022) ||
      digest(await fs.readFile(state.binaryPath)) !== state.hashes.binary) {
    throw failure('unsafe_runtime_state', 'Observer executable changed');
  }
  if (await fs.readFile(state.layoutFile, 'utf8') !== fixedLayout(state) ||
      await fs.readFile(state.tmuxConfig, 'utf8') !== (state.startupRecovery === 1 ? tmuxConfigText : 'set-option -g remain-on-exit on\n')) {
    throw failure('unsafe_runtime_state', 'Observer fixed layout changed');
  }
  return state;
}
export function validRole(role) {
  return !!role && Number.isSafeInteger(role.pid) && role.pid > 0 &&
    Number.isSafeInteger(role.ppid) && role.ppid >= 0 &&
    typeof role.start === 'string' && role.start.length > 0 && role.start.length <= 128 &&
    typeof role.status === 'string' && role.status.length > 0 &&
    typeof role.command === 'string' && role.command.length > 0 && role.command.length <= 32768;
}
export async function readReceipt(state) {
  const receipt = await readJson(path.join(state.root, 'receipt.json'));
  if (receipt.schema !== 2 || receipt.generation !== state.generation || receipt.nonce !== state.nonce ||
      receipt.creationClosed !== true || !['ready', 'failed'].includes(receipt.outcome) ||
      typeof receipt.sessionIssued !== 'boolean' || !['not-issued', 'exited', 'running'].includes(receipt.webLaunch)) {
    throw failure('unsafe_runtime_state', 'Invalid Observer settlement receipt');
  }
  if (!receipt.roles || Object.keys(receipt.roles).sort().join(',') !== 'client,daemon,inner,outer,web') throw failure('unsafe_runtime_state', 'Invalid Observer role inventory');
  for (const role of Object.values(receipt.roles)) {
    if (role !== null && !validRole(role)) {
      throw failure('unsafe_runtime_state', 'Invalid Observer role identity');
    }
  }
  const { outer, client, daemon, inner, web } = receipt.roles;
  if ((!receipt.sessionIssued && (outer || client || daemon || inner || web || receipt.webLaunch !== 'not-issued')) ||
      (receipt.sessionIssued && (!outer || !client || !daemon)) ||
      (receipt.webLaunch === 'running' && !web) ||
      (receipt.webLaunch !== 'running' && web) ||
      (receipt.outcome === 'ready' && (!receipt.sessionIssued || receipt.webLaunch !== 'running' || !inner ||
        Object.values(receipt.roles).some((role) => !role || role.status.startsWith('Z'))))) {
    throw failure('unsafe_runtime_state', 'Inconsistent Observer settlement receipt');
  }
  return receipt;
}
// Used only for inert staging/retired data, or after exact runtime absence proof.
export async function removePrivateTree(root, budget = { count: 0 }) {
  const stat = await fs.lstat(root);
  if (++budget.count > 4096 || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (budget.count === 1 && (!stat.isDirectory() || (stat.mode & 0o077)))) {
    throw failure('unsafe_runtime_state', 'Unsafe Observer cleanup tree');
  }
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(root)) await removePrivateTree(path.join(root, name), budget);
    await fs.rmdir(root);
  } else if (stat.isFile() || stat.isSocket()) await fs.unlink(root);
  else throw failure('unsafe_runtime_state', 'Unexpected Observer cleanup entry');
}
