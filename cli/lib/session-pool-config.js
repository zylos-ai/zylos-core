import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GiB = 1024 ** 3;
const configCaches = new WeakMap();
const capacityCaches = new WeakMap();

function positiveInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[0-9]+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function unreadable() { return Object.assign(new Error('Memory inputs are unreadable'), { code: 'MEMORY_INPUT_UNREADABLE' }); }
function invalid() { return Object.assign(new Error('Memory inputs are invalid'), { code: 'MEMORY_INPUT_INVALID' }); }
function numeric(text) {
  if (!/^-?\d+$/.test(text.trim())) throw unreadable();
  const n = Number(text.trim());
  if (!Number.isFinite(n)) throw unreadable();
  return n;
}
function read(io, file) { return io.readFileSync(file, 'utf8'); }
function field(text, name) {
  const line = text.split('\n').find(value => value.trim().startsWith(name + ' '));
  if (!line) throw unreadable();
  return numeric(line.trim().slice(name.length).trim());
}
function meminfo(io, onlyLimit) {
  const text = read(io, '/proc/meminfo');
  const get = name => {
    const match = text.match(new RegExp(`^${name}:\\s+(-?\\d+)\\s+kB\\s*$`, 'm'));
    if (!match) throw unreadable();
    return numeric(match[1]) * 1024;
  };
  const result = { total: get('MemTotal') };
  if (!onlyLimit) result.available = get('MemAvailable');
  return result;
}
function checked(memory, onlyLimit) {
  if (!Number.isFinite(memory.limitBytes) || memory.limitBytes <= 0) throw invalid();
  if (!onlyLimit && (!Number.isFinite(memory.usedBytes) || memory.usedBytes < 0 || memory.usedBytes > 2 * memory.limitBytes)) throw invalid();
  return memory;
}
function hostMemory(io, onlyLimit) {
  const info = meminfo(io, onlyLimit);
  return checked({ source: 'host', limitBytes: info.total,
    ...(!onlyLimit && { usedBytes: info.total - info.available }) }, onlyLimit);
}
function containerEvidence(io, env, self) {
  return io.existsSync('/.dockerenv') || io.existsSync('/run/.containerenv')
    || Boolean(env.KUBERNETES_SERVICE_HOST) || /^0::\/$/m.test(self ?? '');
}
function groupPath(root, relative) {
  if (!relative.startsWith('/') || relative.split('/').includes('..')) throw unreadable();
  return path.posix.join(root, relative).replace(/\/$/, '');
}
function directoryExists(io, directory) {
  try { return io.statSync(directory).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function cgroupMemory(io, self, onlyLimit) {
  const v2 = io.existsSync('/sys/fs/cgroup/cgroup.controllers');
  const entry = self.split('\n').map(line => line.split(':')).find(parts => v2
    ? parts[0] === '0' && parts[1] === '' : parts[1]?.split(',').includes('memory'));
  if (!entry || entry.length !== 3) throw unreadable();
  const root = v2 ? '/sys/fs/cgroup' : '/sys/fs/cgroup/memory';
  let current = groupPath(root, entry[2]);
  if (!directoryExists(io, current)) {
    if (v2) throw unreadable();
    current = root;
    if (!directoryExists(io, current)) throw unreadable();
  }
  let group = null, minimum = Infinity;
  for (let directory = current; ; directory = path.posix.dirname(directory)) {
    const limitFile = path.posix.join(directory, v2 ? 'memory.max' : 'memory.limit_in_bytes');
    let text;
    try { text = read(io, limitFile).trim(); }
    catch (error) {
      if (!(v2 && directory === root && error.code === 'ENOENT')) throw error;
    }
    if (text !== undefined) {
      const value = v2 && text === 'max' ? Infinity : numeric(text);
      const unlimited = !v2 && value >= 2 ** 62;
      if (!unlimited && value < minimum) { minimum = value; group = directory; }
    }
    if (directory === root) break;
  }
  if (group === null) return hostMemory(io, onlyLimit);
  const info = meminfo(io, onlyLimit);
  const memory = { source: v2 ? 'cgroup2' : 'cgroup1', limitBytes: Math.min(minimum, info.total) };
  if (onlyLimit) return checked(memory, true);
  const usage = numeric(read(io, path.posix.join(group, v2 ? 'memory.current' : 'memory.usage_in_bytes')));
  const stat = read(io, path.posix.join(group, 'memory.stat'));
  const active = field(stat, v2 ? 'active_file' : 'total_active_file');
  const inactive = field(stat, v2 ? 'inactive_file' : 'total_inactive_file');
  memory.usedBytes = usage - active - inactive;
  checked(memory, false);
  memory.usedBytes = Math.max(memory.usedBytes, memory.limitBytes - info.available);
  if (v2) {
    try { memory.oomKills = field(read(io, path.posix.join(group, 'memory.events')), 'oom_kill'); }
    catch { /* The optional event counter does not determine memory usage. */ }
  }
  return checked(memory, false);
}
function linuxMemory(options, onlyLimit) {
  const io = options.fs ?? fs, env = options.env ?? process.env;
  let self;
  try { self = read(io, '/proc/self/cgroup'); }
  catch { /* The other container markers still apply when this file is unreadable. */ }
  try {
    if (self === undefined) throw unreadable();
    return cgroupMemory(io, self, onlyLimit);
  } catch (error) {
    if (error.code === 'MEMORY_INPUT_INVALID' || containerEvidence(io, env, self)) return null;
    try { return hostMemory(io, onlyLimit); } catch { return null; }
  }
}

/** Conservative capacity needs the memory limit only, never live usage or commands. */
export function readMemoryLimit(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') return linuxMemory(options, true);
  if (platform !== 'darwin') return null;
  try { return checked({ source: 'darwin', limitBytes: options.totalMemoryBytes ?? os.totalmem() }, true); }
  catch { return null; }
}
function command(commandName, args, run) {
  return new Promise((resolve, reject) => {
    let child;
    const timer = setTimeout(() => { child?.kill?.(); reject(unreadable()); }, 2000);
    const complete = (error, stdout) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    try { child = run(commandName, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }, complete); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}
function darwinMemory(vm, sysctl) {
  const pageMatch = vm.split('\n')[0]?.match(/page size of (\d+) bytes/);
  if (!pageMatch || Number(pageMatch[1]) <= 0) throw unreadable();
  const pageSize = numeric(pageMatch[1]);
  const pages = name => {
    const line = vm.split('\n').find(value => value.startsWith(name + ':'));
    if (!line) throw unreadable();
    return numeric(line.slice(name.length + 1).trim().replace(/\.$/, ''));
  };
  const limitBytes = numeric(sysctl);
  return checked({ source: 'darwin', limitBytes,
    usedBytes: (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize }, false);
}
/** Live usage is read asynchronously only by the capacity publisher. */
export async function readMemoryInputs(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') return linuxMemory(options, false);
  if (platform !== 'darwin') return null;
  try {
    const run = options.execFile ?? execFile;
    const [vm, sysctl] = await Promise.all([command('vm_stat', [], run), command('sysctl', ['-n', 'hw.memsize'], run)]);
    return darwinMemory(vm, sysctl);
  } catch { return null; }
}
function root(env) { return env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos'); }
function readCachedJson(io, file, caches) {
  let cache = caches.get(io);
  if (!cache) { cache = new Map(); caches.set(io, cache); }
  try {
    const mtime = io.statSync(file).mtimeMs;
    const old = cache.get(file);
    if (old?.mtime === mtime) return old.value;
    const value = JSON.parse(read(io, file));
    cache.set(file, { mtime, value });
    return value;
  } catch { cache.delete(file); return null; }
}
/** Environment overrides the single persisted fixed-capacity setting. */
export function resolveSessionPoolBaseline(options = {}) {
  const env = options.env ?? process.env;
  const explicit = positiveInteger(env.ZYLOS_SESSION_POOL_SIZE);
  if (explicit !== null) return { k: explicit, fixed: true };
  const config = Object.hasOwn(options, 'config') ? options.config
    : readCachedJson(options.fs ?? fs, options.configFile ?? path.join(root(env), '.zylos', 'config.json'), configCaches);
  const fixed = positiveInteger(config?.session_pool_size);
  if (fixed !== null) return { k: fixed, fixed: true };
  const memory = readMemoryLimit(options);
  return { k: memory ? Math.max(1, Math.floor(memory.limitBytes / GiB) - 2) : 1, fixed: false };
}
/** Resolve a published record or a caller's last successful publication. */
export function readPoolCapacity(options = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now();
  const record = Object.hasOwn(options, 'record') ? options.record
    : readCachedJson(options.fs ?? fs, options.file ?? path.join(root(env), 'activity-monitor', 'pool-capacity.json'), capacityCaches);
  const valid = record !== null && typeof record === 'object' && !Array.isArray(record) && record.v === 1
    && Number.isSafeInteger(record.k) && record.k > 0 && Number.isSafeInteger(record.computedAt);
  const fresh = valid && now - record.computedAt >= -5000 && now - record.computedAt <= 60000;
  if (fresh) return { k: record.k, record, valid, fresh, source: record.source ?? 'auto' };
  const baseline = typeof options.baseline === 'function' ? options.baseline()
    : options.baseline ?? resolveSessionPoolBaseline(options);
  const k = baseline.fixed ? baseline.k : valid ? Math.min(record.k, baseline.k) : baseline.k;
  return { k, record, valid, fresh, source: baseline.fixed ? 'fixed' : 'fallback' };
}
