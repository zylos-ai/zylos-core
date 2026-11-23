import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createCgroupCollector } from '../cgroup-resources.js';
import { loadCoreModule } from '../core-modules.js';

const { DEFAULT_RUNTIME } = await loadCoreModule('runtime/descriptors.js');

export function parseVmStatFreeMem(vmStatOutput) {
  const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384;
  const get = (label) => {
    const m = vmStatOutput.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) * pageSize : 0;
  };
  return get('Pages free') + get('Pages speculative') + get('Pages inactive') + get('Pages purgeable');
}

function macosFreeMem(execFile) {
  try {
    const out = execFile('vm_stat', { encoding: 'utf8', timeout: 3000 });
    return parseVmStatFreeMem(out);
  } catch {
    return os.freemem();
  }
}

// MemAvailable is the kernel's estimate of what can still be allocated without swapping. MemFree (os.freemem)
// leaves out reclaimable page cache, so it counts most of the file cache as used.
export function parseMeminfo(text) {
  const get = label => {
    const m = String(text).match(new RegExp(`^${label}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const totalBytes = get('MemTotal'), availableBytes = get('MemAvailable');
  if (!(totalBytes > 0) || availableBytes == null) return null;
  return { totalBytes, availableBytes: Math.min(availableBytes, totalBytes) };
}

/** Total and available memory: Linux reads /proc/meminfo, macOS counts reclaimable pages as available. */
export function readMemory({ platform = process.platform, readFile = fs.readFileSync, execFile = execFileSync } = {}) {
  if (platform === 'linux') {
    try { return parseMeminfo(readFile('/proc/meminfo', 'utf8')); } catch { return null; }
  }
  return { totalBytes: os.totalmem(), availableBytes: platform === 'darwin' ? macosFreeMem(execFile) : os.freemem() };
}

export class SystemCollector {
  constructor(store, config, { readMemory: readMemoryNow = readMemory, cgroupCollector = createCgroupCollector() } = {}) {
    this.store = store;
    this.config = config;
    this._readMemory = readMemoryNow;
    this._cgroup = cgroupCollector;
    this._cache = null;
    this._timer = null;
    this._onUpdate = null;
    this._prevCpuTimes = null;
  }

  async collect() {
    const now = new Date().toISOString();
    const collectedAt = Date.now();
    const runtime = this.config.runtime || DEFAULT_RUNTIME;
    const data = {};

    try {
      const cpuInfo = os.cpus();
      const cpuCount = cpuInfo.length || 1;
      const curTimes = { idle: 0, total: 0 };
      for (const core of cpuInfo) {
        const t = core.times;
        curTimes.idle += t.idle;
        curTimes.total += t.user + t.nice + t.sys + t.idle + t.irq;
      }

      if (this._prevCpuTimes) {
        const idleDelta = curTimes.idle - this._prevCpuTimes.idle;
        const totalDelta = curTimes.total - this._prevCpuTimes.total;
        data.cpu_pct = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

        data.cpu_count = cpuCount;
      }

      this._prevCpuTimes = curTimes;
    } catch (err) {
      process.stderr.write(`[system-collector] CPU error: ${err.message}\n`);
    }

    try {
      const memory = this._readMemory();
      if (memory) {
        data.mem_total_bytes = memory.totalBytes;
        data.mem_used_bytes = memory.totalBytes - memory.availableBytes;
      }
    } catch (err) {
      process.stderr.write(`[system-collector] Memory error: ${err.message}\n`);
    }

    // Each controller chooses its own source. An unreadable limit is unknown,
    // never evidence that a container controller is unlimited.
    this._cgroup.sample();
    const cgroup = this._cgroup.read();
    data.cgroup_version = cgroup.cgroup_version;
    const host = cgroup.cgroup_version === 'none';
    const cpuHost = host || cgroup.cpu_limit_cores === null && !cgroup.errors?.includes('cpu_limit_unreadable');
    const memHost = host || cgroup.mem_total_bytes === null && !cgroup.errors?.includes('memory_limit_unreadable');
    data.cpu_source = cpuHost ? 'host' : 'container';
    data.mem_source = memHost ? 'host' : 'container';
    data.resource_scope = cpuHost === memHost ? data.cpu_source : 'mixed';
    if (!cpuHost) {
      data.cpu_pct = cgroup.cpu_pct;
      data.cpu_count = cgroup.cpu_limit_cores;
      data.cpu_usage_cores = cgroup.cpu_usage_cores;
    }
    if (!memHost) {
      data.mem_used_bytes = cgroup.mem_used_bytes;
      data.mem_total_bytes = cgroup.mem_total_bytes;
      data.mem_pct = cgroup.mem_pct;
    } else {
      data.mem_pct = data.mem_total_bytes > 0 ? +((data.mem_used_bytes / data.mem_total_bytes) * 100).toFixed(2) : null;
    }

    try {
      const stats = fs.statfsSync(this.config.zylosDir);
      const totalBytes = stats.blocks * stats.bsize;
      const availBytes = stats.bavail * stats.bsize;
      data.disk_total_bytes = totalBytes;
      data.disk_free_bytes = availBytes;
      data.disk_used_pct = totalBytes > 0 ? (1 - availBytes / totalBytes) * 100 : 0;

    } catch (err) {
      process.stderr.write(`[system-collector] Disk error: ${err.message}\n`);
    }

    const dims = {
      resource_scope: data.resource_scope,
      cgroup_version: data.cgroup_version,
      cpu_source: data.cpu_source, mem_source: data.mem_source,
      cpu_pct: data.cpu_source === 'container' ? data.cpu_pct : (data.cpu_pct ?? 0),
      cpu_count: data.cpu_source === 'container' ? data.cpu_count : (data.cpu_count ?? (os.cpus().length || 1)),
      cpu_usage_cores: data.cpu_usage_cores ?? null,
      mem_used_bytes: data.mem_used_bytes ?? null,
      mem_total_bytes: data.mem_total_bytes ?? null,
      mem_used_mb: data.mem_used_bytes != null ? +(data.mem_used_bytes / 1024 / 1024).toFixed(2) : null,
      mem_total_mb: data.mem_total_bytes != null ? +(data.mem_total_bytes / 1024 / 1024).toFixed(2) : null,
      mem_used_pct: data.mem_pct,
      disk_used_pct: data.disk_used_pct ?? null,
      disk_free_bytes: data.disk_free_bytes ?? null,
      disk_free_gb: data.disk_free_bytes != null ? +(data.disk_free_bytes / 1024 / 1024 / 1024).toFixed(2) : null,
      path: this.config.zylosDir
    };
    this.store.insertMetric({
      timestamp: now,
      runtime,
      metric_name: 'system_summary',
      // The summary row requires a numeric value; nullable gauges and scope
      // remain in dimensions and the live cache.
      metric_value: dims.cpu_pct ?? 0,
      dimensions: dims,
      source: 'system',
      confidence: 'actual'
    });

    this._cache = { ...data, collectedAt };

    this.store.upsertSourceHealth('system_sampler', 'collector_liveness', 'healthy', {
      last_success: now
    });

    if (this._onUpdate) this._onUpdate(this._cache);
  }

  async warmup() {
    await this.collect();
    await new Promise((r) => setTimeout(r, 200));
    await this.collect();
  }

  getLatestSystemData() {
    return this._cache;
  }

  start(intervalMs = 30_000) {
    this.stop();
    this._timer = setInterval(() => this.collect(), intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
