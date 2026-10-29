import { execFile } from 'node:child_process';

export class PM2Collector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._cache = null;
    this._timer = null;
    this._onUpdate = null;
  }

  async collect() {
    try {
      const raw = await this._execPm2Jlist();
      const processes = JSON.parse(raw);
      const now = new Date().toISOString();
      const collectedAt = Date.now();
      const runtime = this.config.runtime || 'claude';
      const summary = {
        process_count: processes.length,
        total_memory_mb: 0,
        total_cpu_pct: 0,
        total_restarts: 0,
        online: 0,
        stopped: 0,
        errored: 0
      };

      for (const proc of processes) {
        const name = proc.name;
        const env = proc.pm2_env || {};
        const monit = proc.monit || {};
        const status = env.status || 'unknown';
        const memory = Number(monit.memory) || 0;
        const cpu = Number(monit.cpu) || 0;
        const restarts = Number(env.restart_time) || 0;
        const uptime = env.pm_uptime ? Date.now() - env.pm_uptime : 0;

        summary.total_memory_mb += memory / 1024 / 1024;
        summary.total_cpu_pct += cpu;
        summary.total_restarts += restarts;
        if (status === 'online') summary.online++;
        else if (status === 'stopped') summary.stopped++;
        else if (status === 'errored') summary.errored++;

        this.store.upsertPm2State?.(name, {
          status,
          cpu,
          memory_bytes: memory,
          restarts,
          uptime_ms: uptime,
          updated_at: now
        });
      }

      summary.total_memory_mb = +summary.total_memory_mb.toFixed(2);
      summary.total_cpu_pct = +summary.total_cpu_pct.toFixed(2);

      this.store.insertMetric({
        timestamp: now,
        runtime,
        metric_name: 'pm2_summary',
        metric_value: processes.length,
        dimensions: summary,
        source: 'pm2',
        confidence: 'actual'
      });

      this._cache = { processes, collectedAt };

      this.store.upsertSourceHealth('pm2_reader', 'collector_liveness', 'healthy', {
        last_success: now,
        process_count: processes.length
      });

      if (this._onUpdate) this._onUpdate(this._cache);
    } catch (err) {
      process.stderr.write(`[pm2-collector] Error: ${err.message}\n`);
      this.store.upsertSourceHealth('pm2_reader', 'collector_liveness', 'degraded', {
        error: err.message,
        last_error: new Date().toISOString()
      });
    }
  }

  getLatestPM2Data() {
    return this._cache;
  }

  start(intervalMs = 15_000) {
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

  _execPm2Jlist() {
    return new Promise((resolve, reject) => {
      execFile('pm2', ['jlist'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }
}
