/**
 * cgroup-resources.js — container-scoped CPU and memory gauges read straight
 * from cgroup (v2 primary, v1 fallback).
 *
 * Ported from cws-zylos-runtime's ops-daemon `resources.go`
 * (pkg/opsdaemon) — the reference implementation for container-correct
 * resource collection.
 *
 * WHY this exists: `os.cpus()` / `os.totalmem()` (the host sampler's
 * defaults) are NODE-level inside a container — they are not cgroup-aware, so
 * in a limited container they report the host node's cores/RAM and host-wide
 * utilization, not this container's quota and actual consumption. These
 * readers see the container's real limits and usage instead:
 *   - CPU:    cpu.max / cpu.stat:usage_usec       (v1: cpu.cfs_quota_us / cpuacct.usage)
 *             usage_usec is CUMULATIVE, so a percentage needs two samples —
 *             the caller ticks `sample()` and `read()` returns the delta.
 *   - Memory: memory.max / memory.current         (v1: memory.limit_in_bytes / memory.usage_in_bytes)
 *             "used" is the WORKING SET (current - inactive_file), matching
 *             `kubectl top`, not raw `current` (which counts reclaimable page
 *             cache).
 *
 * Disk is intentionally NOT collected here: the dashboard's statfs on the
 * volume mount root is already the correct (container-visible) scope, so disk
 * stays sourced from the dashboard. This module owns only CPU + memory.
 */

import fs from 'node:fs';
import path from 'node:path';

// cgroup v1 reports "no memory limit" as PAGE_COUNTER_MAX (~9.2e18), not as a
// missing file. Anything >= 2^62 is treated as unlimited (mirrors v2's "max").
const V1_NO_LIMIT_SENTINEL = 2 ** 62;

const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';

function defaultReadFile(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

/**
 * Create a cgroup CPU/memory collector.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.cgroupRoot]  cgroup mount root (default /sys/fs/cgroup)
 * @param {function} [opts.readFile]    (absPath) => string; throws when missing
 * @param {function} [opts.now]         () => epoch ms
 * @returns {{ sample: () => void, read: () => object }}
 *   sample() — take one cumulative CPU-usage sample (call once per tick).
 *   read()   — normalized gauges for reporting:
 *     { cpu_pct, cpu_usage_cores, cpu_limit_cores,
 *       mem_pct, mem_total_bytes, mem_used_bytes,
 *       cgroup_version, errors }
 *   Fields are null when unreadable/unlimited; never throws.
 */
export function createCgroupCollector({
  cgroupRoot = DEFAULT_CGROUP_ROOT,
  readFile = defaultReadFile,
  now = Date.now,
} = {}) {
  let prevUsage = 0;
  let prevAt = 0;
  let curUsage = 0;
  let curAt = 0;
  let haveCur = false; // one sample taken (epoch-0 is a valid timestamp, so a flag — not curAt===0)
  let haveTwo = false;

  // Read a cgroup file relative to the root; null on any failure (missing
  // file, controller absent, permission). Callers branch on null, never throw.
  const readRaw = (...parts) => {
    try {
      return String(readFile(path.join(cgroupRoot, ...parts))).trim();
    } catch {
      return null;
    }
  };

  function cgroupVersion() {
    if (readRaw('cpu.max') !== null) return 'v2';
    if (readRaw('memory.max') !== null) return 'v2';
    if (readRaw('cpu', 'cpu.cfs_quota_us') !== null
        || readRaw('memory', 'memory.limit_in_bytes') !== null) {
      // v1 controller files also exist at a bare host's hierarchy root. Their
      // presence alone does not establish container scope. Require a finite
      // quota or memory limit; an entirely unlimited v1 container deliberately
      // falls back to host metrics too, since these files cannot distinguish it
      // from an unlimited host root reliably.
      const cpu = readCpuLimitCores();
      const memory = readMemLimitBytes();
      if (cpu.limitCores > 0 || memory.limitBytes > 0 || !cpu.found || !memory.found) return 'v1';
    }
    return 'none';
  }

  // CPU quota in cores; limitCores null = unlimited (v2 "max" literal / v1 -1).
  function readCpuLimitCores() {
    const v2 = readRaw('cpu.max');
    if (v2 !== null) {
      const f = v2.split(/\s+/);
      if (f.length !== 2) return { found: false };
      if (f[0] === 'max') return { limitCores: null, found: true };
      const quota = Number(f[0]);
      const period = Number(f[1]);
      if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return { found: false };
      return { limitCores: quota / period, found: true };
    }
    const quotaRaw = readRaw('cpu', 'cpu.cfs_quota_us');
    if (quotaRaw === null) return { found: false };
    const quota = Number(quotaRaw);
    if (!Number.isFinite(quota)) return { found: false };
    if (quota < 0) return { limitCores: null, found: true }; // v1 sentinel: -1 = unlimited
    const periodRaw = readRaw('cpu', 'cpu.cfs_period_us');
    if (periodRaw === null) return { found: false };
    const period = Number(periodRaw);
    if (!Number.isFinite(period) || period <= 0) return { found: false };
    return { limitCores: quota / period, found: true };
  }

  // Cumulative CPU time in microseconds (v1 cpuacct.usage is nanoseconds).
  function readCpuUsageUsec() {
    const v2 = readRaw('cpu.stat');
    if (v2 !== null) {
      for (const line of v2.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length === 2 && f[0] === 'usage_usec') {
          const n = Number(f[1]);
          return Number.isFinite(n) ? { usec: n, ok: true } : { ok: false };
        }
      }
      return { ok: false };
    }
    const v1 = readRaw('cpu', 'cpuacct.usage');
    if (v1 !== null) {
      const n = Number(v1);
      return Number.isFinite(n) ? { usec: n / 1000, ok: true } : { ok: false };
    }
    return { ok: false };
  }

  // Memory limit in bytes; limitBytes null = unlimited (v2 "max" / v1 sentinel).
  function readMemLimitBytes() {
    const v2 = readRaw('memory.max');
    if (v2 !== null) {
      if (v2 === 'max') return { limitBytes: null, found: true };
      const n = Number(v2);
      return Number.isFinite(n) ? { limitBytes: n, found: true } : { found: false };
    }
    const v1 = readRaw('memory', 'memory.limit_in_bytes');
    if (v1 === null) return { found: false };
    const n = Number(v1);
    if (!Number.isFinite(n)) return { found: false };
    if (n >= V1_NO_LIMIT_SENTINEL) return { limitBytes: null, found: true };
    return { limitBytes: n, found: true };
  }

  function readMemCurrentBytes() {
    const v2 = readRaw('memory.current');
    if (v2 !== null) {
      const n = Number(v2);
      return Number.isFinite(n) ? { bytes: n, ok: true } : { ok: false };
    }
    const v1 = readRaw('memory', 'memory.usage_in_bytes');
    if (v1 !== null) {
      const n = Number(v1);
      return Number.isFinite(n) ? { bytes: n, ok: true } : { ok: false };
    }
    return { ok: false };
  }

  // inactive_file (v2 memory.stat) / total_inactive_file (v1) for working set.
  function readInactiveFileBytes() {
    let raw = readRaw('memory.stat');
    let key = 'inactive_file';
    if (raw === null) {
      raw = readRaw('memory', 'memory.stat');
      key = 'total_inactive_file';
      if (raw === null) return { ok: false };
    }
    for (const line of raw.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length === 2 && f[0] === key) {
        const n = Number(f[1]);
        return Number.isFinite(n) ? { bytes: n, ok: true } : { ok: false };
      }
    }
    return { ok: false };
  }

  // Take one cumulative CPU-usage sample. usage_usec is monotonic, so a
  // percentage needs two samples — this keeps the previous one for the delta.
  function sample() {
    const u = readCpuUsageUsec();
    if (!u.ok) {
      // Never publish the previous window as this tick's measurement. Start a
      // fresh two-sample window once the cumulative counter becomes readable.
      haveCur = false;
      haveTwo = false;
      return;
    }
    const t = now();
    if (haveCur) {
      prevUsage = curUsage;
      prevAt = curAt;
      haveTwo = true;
    }
    curUsage = u.usec;
    curAt = t;
    haveCur = true;
  }

  // Measured CPU consumption in cores over the last window; null until two
  // samples exist (or on a counter reset / non-positive window).
  function usageCores() {
    if (!haveTwo) return null;
    const wallUs = (curAt - prevAt) * 1000; // ms → µs
    if (wallUs <= 0 || curUsage < prevUsage) return null;
    return (curUsage - prevUsage) / wallUs;
  }

  function read() {
    const errors = [];
    const version = cgroupVersion();

    // CPU
    let cpuPct = null;
    const { limitCores, found: cpuLimFound } = readCpuLimitCores();
    if (!cpuLimFound) errors.push('cpu_limit_unreadable');
    const cores = usageCores();
    if (cores != null && limitCores != null && limitCores > 0) {
      cpuPct = (cores / limitCores) * 100;
    }

    // Memory
    let memPct = null;
    let memUsed = null;
    const { limitBytes, found: memLimFound } = readMemLimitBytes();
    if (!memLimFound) errors.push('memory_limit_unreadable');
    const memTotal = limitBytes ?? null;
    const cur = readMemCurrentBytes();
    if (cur.ok) {
      let workingSet = cur.bytes;
      const inactive = readInactiveFileBytes();
      if (inactive.ok && inactive.bytes <= cur.bytes) {
        workingSet = cur.bytes - inactive.bytes;
      }
      memUsed = workingSet;
      // usage_pct numerator is the working set, never raw `current` — current
      // includes reclaimable page cache (kubectl top parity).
      if (limitBytes != null && limitBytes > 0) {
        memPct = (workingSet / limitBytes) * 100;
      }
    } else {
      errors.push('memory_usage_unreadable');
    }

    return {
      cpu_pct: round2(cpuPct),
      cpu_usage_cores: round2(cores),
      cpu_limit_cores: limitCores ?? null,
      mem_pct: round2(memPct),
      mem_total_bytes: memTotal,
      mem_used_bytes: memUsed,
      cgroup_version: version,
      errors,
    };
  }

  // Seed one CPU sample at construction so the first report tick already has a
  // differential window (mirrors ops-daemon calling sampleCPU() in start()).
  sample();

  return { sample, read };
}
