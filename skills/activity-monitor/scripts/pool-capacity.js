import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MiB = 1024 ** 2;
const DAY = 24 * 60 * 60 * 1000;
const SAMPLE_WINDOW = 7 * DAY;
const COMPUTE_INTERVAL = 10000;
const SAMPLE_INTERVAL = 30000;
const STABLE_INTERVAL = 120000;
const RISE_WINDOW = 120000;
const NOTICE_DELAY = 60000;
const NOTICE_INTERVAL = 1800000;
const SAMPLE_NAME = 'pool-memory-samples.jsonl';
const SOURCES = new Set(['cgroup2', 'cgroup1', 'host', 'darwin']);

/** Fit only the current source and seven-day window, with high-rank buckets. */
export function fitMemoryModel(samples, { now = Date.now(), source } = {}) {
  const groups = new Map();
  for (const row of samples) {
    if (row.src !== source || row.ts < now - SAMPLE_WINDOW || row.ts > now) continue;
    const values = groups.get(row.n) ?? [];
    values.push(row.w);
    groups.set(row.n, values);
  }
  const buckets = [...groups].filter(([, values]) => values.length >= 60)
    .sort(([a], [b]) => a - b).map(([n, values]) => {
      values.sort((a, b) => a - b);
      return { n, highBytes: values[Math.ceil(0.95 * values.length) - 1], samples: values.length };
    });
  if (buckets.length < 2) return { state: 'default', slopeBytes: 512 * MiB, windowDays: 7, buckets };
  const slopes = [];
  for (let i = 0; i < buckets.length; i++) {
    for (let j = i + 1; j < buckets.length; j++) {
      slopes.push((buckets[j].highBytes - buckets[i].highBytes) / (buckets[j].n - buckets[i].n));
    }
  }
  slopes.sort((a, b) => a - b);
  const slopeBytes = Math.max(256 * MiB, slopes[Math.floor(slopes.length / 2)]);
  const interceptBytes = Math.max(...buckets.map(row => row.highBytes - slopeBytes * row.n));
  return { state: 'fitted', slopeBytes, interceptBytes, windowDays: 7, buckets };
}

export function calculateMemoryCapacity(memory, n, model) {
  const reserveBytes = Math.max(512 * MiB, Math.floor(memory.limitBytes * 0.1));
  const current = n + Math.floor((memory.limitBytes - reserveBytes - memory.usedBytes) / model.slopeBytes);
  const total = model.state === 'fitted'
    ? Math.min(current, Math.floor((memory.limitBytes - reserveBytes - model.interceptBytes) / model.slopeBytes))
    : current;
  const kMemory = total - 1;
  return { kMemory, kRaw: Math.max(kMemory, 1), reserveBytes, reason: kMemory < 1 ? 'floor' : 'memory' };
}

/** Rename is the only publication point: readers see either complete record. */
export function writeCapacityAtomic(file, record, { fs: io = fs } = {}) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(fd, JSON.stringify(record) + '\n');
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function validSample(row) {
  return row && row.v === 1 && Number.isSafeInteger(row.ts) && Number.isSafeInteger(row.n) && row.n >= 0
    && Number.isSafeInteger(row.pool) && row.pool >= 0 && typeof row.origin === 'boolean'
    && row.n === row.pool + Number(row.origin) && Number.isFinite(row.w) && row.w >= 0
    && Number.isFinite(row.limit) && row.limit > 0 && SOURCES.has(row.src);
}
function validMemory(memory) {
  return memory && SOURCES.has(memory.source) && Number.isFinite(memory.limitBytes) && memory.limitBytes > 0
    && Number.isFinite(memory.usedBytes) && memory.usedBytes >= 0 && memory.usedBytes <= 2 * memory.limitBytes;
}

/** One owner calculates and publishes before checking memory protection. */
export class PoolCapacity {
  constructor({ directory, readMemory, resolveBaseline, now = Date.now, log = () => {}, fs: io = fs,
    notify = () => {}, reclaim = async () => null,
    publish = (file, record) => writeCapacityAtomic(file, record, { fs: io }) }) {
    Object.assign(this, { directory, readMemory, resolveBaseline, now, log, io, publish, notify, reclaim });
    this.file = path.join(directory, 'pool-capacity.json');
    this.sampleFile = path.join(directory, SAMPLE_NAME);
    this.samples = [];
    this.loaded = false;
    this.mode = null;
    this.epoch = 0;
    this.lastPublished = null;
    this.inputsUnreadableSince = null;
    this.publishFailedSince = null;
    this.noticeSent = new Map();
    this.pressureCount = 0;
    this.oomKills = null;
    this.lastComputedAt = null;
    this.lastSampleAt = null;
    this.currentK = null;
    this.startedAt = null;
    this.history = [];
    this.wasFixed = false;
    this.wasFallback = false;
    this.samplingBlocked = false;
    this.stableN = null;
    this.stableSince = null;
    this.computing = false;
  }

  diagnostic(event, details = {}) { this.log({ event, ...details }); }

  notice(id, now) {
    if (this.noticeSent.has(id) && now - this.noticeSent.get(id) < NOTICE_INTERVAL) return;
    this.noticeSent.set(id, now);
    this.notify(id);
  }

  checkFailureNotices(now = this.now()) {
    if (this.mode !== 'multi') return;
    for (const [id, since] of [['inputs_unreadable', this.inputsUnreadableSince], ['publish_failed', this.publishFailedSince]]) {
      if (since !== null && now - since >= NOTICE_DELAY) this.notice(id, now);
    }
  }

  loadSamples(now) {
    this.loaded = true;
    let names;
    try { names = this.io.readdirSync(this.directory); }
    catch (error) { if (error.code !== 'ENOENT') this.diagnostic('capacity_samples_read_failed', { error: error.code }); return; }
    let skipped = 0;
    for (const name of names) {
      const match = /^pool-memory-samples\.(\d+)\.jsonl$/.exec(name);
      if (name !== SAMPLE_NAME && !match) continue;
      const file = path.join(this.directory, name);
      if (match && Number(match[1]) < now - 8 * DAY) {
        try { this.io.unlinkSync(file); } catch (error) { this.diagnostic('capacity_samples_prune_failed', { error: error.code }); }
        continue;
      }
      if (match && Number(match[1]) < now - SAMPLE_WINDOW) continue;
      let content;
      try { content = this.io.readFileSync(file, 'utf8'); }
      catch (error) { this.diagnostic('capacity_samples_read_failed', { error: error.code }); continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { skipped++; continue; }
        if (!validSample(row)) { skipped++; continue; }
        if (row.ts >= now - SAMPLE_WINDOW && row.ts <= now) this.samples.push(row);
      }
    }
    if (skipped) this.diagnostic('capacity_samples_skipped', { count: skipped });
  }

  appendSample(row) {
    try {
      this.io.mkdirSync(this.directory, { recursive: true });
      let rotate = false;
      try {
        const stat = this.io.statSync(this.sampleFile);
        const first = this.io.readFileSync(this.sampleFile, 'utf8').split('\n', 1)[0];
        let timestamp;
        try { timestamp = JSON.parse(first).ts; } catch { /* Bad lines are diagnosed on replay. */ }
        rotate = stat.size > 10 * MiB || (Number.isFinite(timestamp) && timestamp < row.ts - DAY);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (rotate) this.io.renameSync(this.sampleFile, path.join(this.directory, `pool-memory-samples.${row.ts}.jsonl`));
      // One append call writes the complete decision-input record.
      this.io.appendFileSync(this.sampleFile, JSON.stringify(row) + '\n', { mode: 0o600 });
      this.samples.push(row);
      for (const name of this.io.readdirSync(this.directory)) {
        const match = /^pool-memory-samples\.(\d+)\.jsonl$/.exec(name);
        if (match && Number(match[1]) < row.ts - 8 * DAY) {
          try { this.io.unlinkSync(path.join(this.directory, name)); }
          catch (error) { this.diagnostic('capacity_samples_prune_failed', { error: error.code }); }
        }
      }
    } catch (error) { this.diagnostic('capacity_samples_write_failed', { error: error.code }); }
  }

  smooth(kRaw, baseline, now) {
    if (this.currentK === null || this.wasFixed) {
      this.startedAt = now;
      this.history = [];
      return Math.min(kRaw, baseline.k);
    }
    this.history.push(kRaw);
    this.history = this.history.slice(-12);
    if (kRaw < this.currentK) return kRaw;
    if (now - this.startedAt >= RISE_WINDOW && this.history.length >= 12
      && this.history.every(k => k > this.currentK)) return Math.min(...this.history);
    return this.currentK;
  }

  async tick({ mode, scenes = [], transitioning = false, now = this.now() } = {}) {
    if (mode !== 'multi') {
      if (this.mode === 'multi') this.epoch++;
      this.mode = mode; this.lastComputedAt = null; this.currentK = null;
      this.history = []; this.stableN = null; this.stableSince = null; this.wasFixed = false; this.wasFallback = false;
      this.inputsUnreadableSince = null; this.publishFailedSince = null; this.pressureCount = 0; this.oomKills = null;
      return null;
    }
    this.mode = mode;
    const present = scenes.filter(scene => scene.present);
    const origin = present.some(scene => scene.sessionGroup === 'origin' || scene.sessionGroup === null);
    const sessions = { n: present.length, pool: present.length - Number(origin), origin };
    this.samplingBlocked = transitioning || present.some(scene => !scene.ready);
    if (sessions.n !== this.stableN) { this.stableN = sessions.n; this.stableSince = now; }
    if (this.computing || (this.lastComputedAt !== null && now - this.lastComputedAt < COMPUTE_INTERVAL)) return null;
    this.lastComputedAt = now;
    this.computing = true;
    const epoch = this.epoch;
    try {
      if (!this.loaded) this.loadSamples(now);
      const baseline = await this.resolveBaseline();
      let memory;
      try { memory = await this.readMemory(); } catch { memory = null; }
      if (epoch !== this.epoch || this.mode !== 'multi') return null;
      const readable = validMemory(memory);
      if (readable || baseline.fixed) this.inputsUnreadableSince = null;
      else this.inputsUnreadableSince ??= now;
      this.samples = this.samples.filter(row => row.ts >= now - SAMPLE_WINDOW && row.ts <= now);
      let model;
      if (readable) {
        if (!this.samplingBlocked
          && now - this.stableSince >= STABLE_INTERVAL
          && (this.lastSampleAt === null || now - this.lastSampleAt >= SAMPLE_INTERVAL)) {
          this.lastSampleAt = now;
          this.appendSample({ v: 1, ts: now, ...sessions, w: memory.usedBytes, limit: memory.limitBytes, src: memory.source });
        }
        model = fitMemoryModel(this.samples, { now, source: memory.source });
      }
      const calculation = readable ? calculateMemoryCapacity(memory, sessions.n, model) : null;
      let source, reason, k, kRaw;
      if (baseline.fixed) { source = 'fixed'; reason = 'fixed'; k = baseline.k; kRaw = calculation?.kRaw ?? k; }
      else if (!readable) { source = 'fallback'; reason = 'inputs_unreadable'; kRaw = k = 1; this.history = []; }
      else {
        source = 'auto'; reason = calculation.reason; kRaw = calculation.kRaw;
        if (this.wasFallback) { this.startedAt = now; this.history = []; }
        k = this.smooth(kRaw, baseline, now);
      }
      const record = { v: 1, k, source, reason, computedAt: now, kRaw, sessions };
      if (calculation) {
        record.kMemory = calculation.kMemory;
        record.memory = { source: memory.source, limitBytes: memory.limitBytes, usedBytes: memory.usedBytes, reserveBytes: calculation.reserveBytes };
        if (memory.source === 'cgroup2' && memory.oomKills !== undefined) record.memory.oomKills = memory.oomKills;
        record.model = model;
      }
      try {
        await this.publish(this.file, record);
        this.lastPublished = record;
        this.currentK = k;
        this.wasFixed = baseline.fixed;
        this.publishFailedSince = null;
      } catch (error) {
        this.publishFailedSince = baseline.fixed ? null : (this.publishFailedSince ?? now);
        this.diagnostic('capacity_publish_failed', { error: error.code });
      }
      // Cancelling a fixed value keeps the startup bound until it is published.
      if (baseline.fixed) this.wasFixed = true;
      this.wasFallback = source === 'fallback';
      if (epoch !== this.epoch || this.mode !== 'multi') return record;
      this.checkFailureNotices(now);
      const oomKills = readable && memory.source === 'cgroup2' && Number.isSafeInteger(memory.oomKills) && memory.oomKills >= 0
        ? memory.oomKills : null;
      if (oomKills !== null) {
        if (this.oomKills !== null && oomKills > this.oomKills) {
          this.diagnostic('container_oom_kill', { oomKills, previousOomKills: this.oomKills });
          this.notice('oom_kill', now);
        }
        this.oomKills = oomKills;
      }
      const pressure = source === 'auto' && readable && memory.usedBytes >= memory.limitBytes - calculation.reserveBytes / 2;
      this.pressureCount = pressure ? Math.min(2, this.pressureCount + 1) : 0;
      if (this.pressureCount === 2) {
        const selected = await this.reclaim(record, () => epoch === this.epoch && this.mode === 'multi');
        if (selected && epoch === this.epoch && this.mode === 'multi') {
          this.diagnostic('capacity_pressure_evict', { usedBytes: memory.usedBytes, limitBytes: memory.limitBytes, k, session_group: selected.sessionGroup });
          this.notice('memory_reclaim', now);
        }
      }
      return record;
    } finally { this.computing = false; }
  }
}
