import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const runtimeRoot = () => process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function durableJson(file, value) {
  const directory = path.dirname(file);
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created) syncDirectory(path.dirname(directory));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* Only this writer's temporary file. */ }
    throw error;
  }
}
export function createRuntimeGeneration(runtime, { zylosDir = runtimeRoot(), nowMs = Date.now() } = {}) {
  if (!['claude', 'codex'].includes(runtime)) throw new Error('Unsupported runtime identity');
  const record = { schema_version: 1, runtime, runtime_generation: randomUUID(), created_at: nowMs };
  durableJson(path.join(zylosDir, 'activity-monitor', 'runtime-generation.json'), record);
  return record;
}
export function readRuntimeGeneration(zylosDir = runtimeRoot()) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(zylosDir, 'activity-monitor', 'runtime-generation.json'), 'utf8'));
    if (record?.schema_version !== 1 || !['claude', 'codex'].includes(record.runtime) || !/^[0-9a-f-]{36}$/.test(record.runtime_generation) || !Number.isFinite(record.created_at)) return null;
    return record;
  } catch { return null; }
}
export function runtimeGenerationEnv(record) {
  return { ZYLOS_RUNTIME_ID: record.runtime, ZYLOS_RUNTIME_GENERATION: record.runtime_generation };
}
export function readProcessStart(pid, { platform = process.platform, readFileSync = fs.readFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^\d+$/.test(ticks) && /^[0-9a-f-]{36}$/.test(boot) ? `${boot}:${ticks}` : null;
  } catch { return null; }
}
