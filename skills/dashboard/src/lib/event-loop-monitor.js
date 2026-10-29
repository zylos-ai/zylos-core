import { monitorEventLoopDelay } from 'node:perf_hooks';

const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_BLOCK_WARN_MS = 1_000;
const WINDOW_SAMPLES = 12; // rolling worst-of ~1 minute at the default interval

// Continuous event-loop delay observability (#260). The Day 164 wedge left the
// process "online" in PM2 while HTTP went unanswered for minutes — this makes
// that state measurable from /api/health and loggable as it happens, instead
// of being diagnosed blind after a restart.
export class EventLoopMonitor {
  constructor({ sampleIntervalMs, blockWarnMs, log } = {}) {
    this.sampleIntervalMs = sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.blockWarnMs = blockWarnMs ?? DEFAULT_BLOCK_WARN_MS;
    this.log = log || ((line) => process.stderr.write(line));
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.last = null;
    this.recentMax = [];
    this.timer = null;
  }

  start() {
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs);
    this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram.disable();
  }

  sample() {
    const toMs = (ns) => Math.round(ns / 1e6 * 10) / 10;
    const snapshot = {
      p50_ms: toMs(this.histogram.percentile(50)),
      p99_ms: toMs(this.histogram.percentile(99)),
      max_ms: toMs(this.histogram.max),
      sampled_at: new Date().toISOString()
    };
    this.histogram.reset();
    this.last = snapshot;
    this.recentMax.push(snapshot.max_ms);
    if (this.recentMax.length > WINDOW_SAMPLES) this.recentMax.shift();
    if (snapshot.max_ms >= this.blockWarnMs) {
      this.log(`[event-loop] blocked ~${snapshot.max_ms}ms in the last ${this.sampleIntervalMs}ms window (p99 ${snapshot.p99_ms}ms)\n`);
    }
    return snapshot;
  }

  snapshot() {
    if (!this.last) return null;
    return {
      ...this.last,
      window_max_ms: this.recentMax.length ? Math.max(...this.recentMax) : null
    };
  }
}
