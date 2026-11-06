const RANGES = { '6h': [6 * 3600000, 60], '24h': [24 * 3600000, 300], '7d': [7 * 86400000, 1800] };
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function hostSeries(store, { range = '6h', now = new Date(), pm2Data = null } = {}) {
  const setting = Object.hasOwn(RANGES, range) ? RANGES[range] : null;
  if (!setting) throw Object.assign(new Error('invalid_range'), { statusCode: 400, code: 'invalid_range' });
  const [duration, bucketSeconds] = setting, end = now.getTime(), start = end - duration;
  const since = new Date(start).toISOString(), until = now.toISOString();
  const rows = store.queryMetrics({ name: 'system_summary', since, until });
  const buckets = new Map();
  const width = bucketSeconds * 1000, count = duration / width;
  const emptyField = () => ({ sum: 0, count: 0, max: null });
  for (let index = 0; index < count; index++) buckets.set(index,
    { at: new Date(start + index * width).toISOString(), cpu: emptyField(), mem: emptyField(), disk: emptyField() });
  let cpuPeak = null;
  for (const row of rows) {
    const timestamp = new Date(row.timestamp).getTime();
    const bucket = buckets.get(Math.min(count - 1, Math.floor((timestamp - start) / width)));
    if (!bucket) continue;
    for (const [field, dimension] of [['cpu', 'cpu_pct'], ['mem', 'mem_used_pct'], ['disk', 'disk_used_pct']]) {
      const value = finite(row.dimensions?.[dimension]);
      if (value !== null) {
        const values = bucket[field];
        values.sum += value; values.count++;
        values.max = values.max === null ? value : Math.max(values.max, value);
      }
      if (field === 'cpu' && value !== null && (cpuPeak === null || value > cpuPeak.value)) cpuPeak = { value, at: row.timestamp };
    }
  }
  const series = [...buckets.values()].map(bucket => {
    for (const field of ['cpu', 'mem', 'disk']) {
      const values = bucket[field];
      bucket[field] = values.count ? { avg: values.sum / values.count, max: values.max } : null;
    }
    return bucket;
  });
  const latest = rows.at(-1);
  const processes = pm2Data?.processes;
  return { range, since, until, bucketSeconds,
    current: { cpu_pct: finite(latest?.dimensions?.cpu_pct), mem_used_pct: finite(latest?.dimensions?.mem_used_pct),
      disk_used_pct: finite(latest?.dimensions?.disk_used_pct), at: latest?.timestamp ?? null },
    pm2: Array.isArray(processes) ? { online: processes.filter(item => item.pm2_env?.status === 'online').length,
      total: processes.length, at: Number.isFinite(pm2Data.collectedAt) ? new Date(pm2Data.collectedAt).toISOString() : null } : null,
    series, cpuPeak };
}
