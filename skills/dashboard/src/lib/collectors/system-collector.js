import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function parseVmStatFreeMem(vmStatOutput) {
  const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384;
  const get = (label) => {
    const m = vmStatOutput.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) * pageSize : 0;
  };
  return get('Pages free') + get('Pages speculative') + get('Pages inactive') + get('Pages purgeable');
}

function macosFreeMem() {
  try {
    const out = execFileSync('vm_stat', { encoding: 'utf8', timeout: 3000 });
    return parseVmStatFreeMem(out);
  } catch {
    return os.freemem();
  }
}

export class SystemCollector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._cache = null;
    this._timer = null;
    this._onUpdate = null;
    this._prevCpuTimes = null;
  }

  async collect() {
    const now = new Date().toISOString();
    const collectedAt = Date.now();
    const runtime = this.config.runtime || 'claude';
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
      data.mem_total_bytes = os.totalmem();
      const freeMem = process.platform === 'darwin' ? macosFreeMem() : os.freemem();
      data.mem_used_bytes = data.mem_total_bytes - freeMem;

    } catch (err) {
      process.stderr.write(`[system-collector] Memory error: ${err.message}\n`);
    }

    try {
      const stats = fs.statfsSync(this.config.zylosDir);
      const totalBytes = stats.blocks * stats.bsize;
      const availBytes = stats.bavail * stats.bsize;
      data.disk_free_bytes = availBytes;
      data.disk_used_pct = totalBytes > 0 ? (1 - availBytes / totalBytes) * 100 : 0;

    } catch (err) {
      process.stderr.write(`[system-collector] Disk error: ${err.message}\n`);
    }

    const dims = {
      cpu_pct: data.cpu_pct ?? 0,
      cpu_count: data.cpu_count ?? (os.cpus().length || 1),
      mem_used_bytes: data.mem_used_bytes ?? null,
      mem_total_bytes: data.mem_total_bytes ?? null,
      mem_used_mb: data.mem_used_bytes != null ? +(data.mem_used_bytes / 1024 / 1024).toFixed(2) : null,
      mem_total_mb: data.mem_total_bytes != null ? +(data.mem_total_bytes / 1024 / 1024).toFixed(2) : null,
      mem_used_pct: data.mem_total_bytes > 0 ? +((data.mem_used_bytes / data.mem_total_bytes) * 100).toFixed(2) : null,
      disk_used_pct: data.disk_used_pct ?? null,
      disk_free_bytes: data.disk_free_bytes ?? null,
      disk_free_gb: data.disk_free_bytes != null ? +(data.disk_free_bytes / 1024 / 1024 / 1024).toFixed(2) : null,
      path: this.config.zylosDir
    };
    this.store.insertMetric({
      timestamp: now,
      runtime,
      metric_name: 'system_summary',
      metric_value: dims.cpu_pct,
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
