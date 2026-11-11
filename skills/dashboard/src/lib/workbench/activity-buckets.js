import { workingHistory, eventTime } from './working.js';

const WAIT_TYPES = new Set(['permission_request', 'wait_health', 'wait_capacity']);
const ERROR_TYPES = new Set(['activate_failed', 'activate_timeout']);
const PRIORITY = { none: 0, idle: 1, busy: 2, waiting: 3, error: 4 };
const milliseconds = value => typeof value === 'number' ? value : Date.parse(value);

/** Display-only intervals; no scheduler state or persistence is changed. */
export function activityBuckets({ range, now, rows, events = [], inbound = [], ttlMs = 1800000 }) {
  const spec = range === '60m' ? { count: 60, seconds: 60 }
    : range === '6h' ? { count: 72, seconds: 300 } : null;
  if (!spec) throw Object.assign(new Error('Unsupported activity range'), { statusCode: 400, code: 'invalid_range' });
  const width = spec.seconds * 1000, start = Math.floor(now / width) * width - (spec.count - 1) * width;
  const currentRuns = new Map(rows.filter(row => row.sessionGroup !== null)
    .map(row => [row.sessionGroup, row.live?.runId ?? null]));
  const groups = Object.fromEntries([...currentRuns.keys()].map(key => [key, { cells: Array(spec.count).fill('none'), inbound: [] }]));
  const runs = new Map();
  for (const event of events) {
    if (!currentRuns.has(event.session_group)) continue;
    const at = milliseconds(event.timestamp);
    if (!Number.isFinite(at) || at > now) continue;
    let groupRuns = runs.get(event.session_group);
    if (!groupRuns) { groupRuns = new Map(); runs.set(event.session_group, groupRuns); }
    let run = groupRuns.get(event.run_id);
    if (!run) { run = []; groupRuns.set(event.run_id, run); }
    run.push({ ...event, at });
  }
  for (const row of rows) {
    if (!currentRuns.has(row.sessionGroup) || row.live?.runId == null) continue;
    let groupRuns = runs.get(row.sessionGroup);
    if (!groupRuns) { groupRuns = new Map(); runs.set(row.sessionGroup, groupRuns); }
    if (!groupRuns.has(row.live.runId)) groupRuns.set(row.live.runId, []);
  }
  for (const [key, groupRuns] of runs) {
    const cells = groups[key].cells;
    const paint = (from, to, kind) => {
      if (to < from || to < start || from >= start + spec.count * width) return;
      const first = Math.max(0, Math.floor((from - start) / width));
      const last = Math.min(spec.count - 1, Math.ceil((to - start) / width) - 1);
      // A point event/run still belongs to its containing half-open cell.
      const end = to === from ? Math.min(spec.count - 1, Math.floor((to - start) / width)) : last;
      for (let index = first; index <= end; index++) {
        if (PRIORITY[kind] > PRIORITY[cells[index]]) cells[index] = kind;
      }
    };
    for (const [runId, run] of groupRuns) {
      run.sort((a, b) => a.at - b.at || (a.event_seq ?? 0) - (b.event_seq ?? 0));
      const current = runId != null && runId === currentRuns.get(key);
      // Include the sampled instant in the current cell, even at a boundary.
      const end = current ? now + 1 : run.at(-1).at;
      if (runId != null) {
        const row = current ? rows.find(row => row.sessionGroup === key) : null;
        const createdAt = typeof row?.createdAt === 'number' ? row.createdAt * 1000 : milliseconds(row?.createdAt);
        const from = current && Number.isFinite(createdAt) ? createdAt : run[0]?.at ?? start;
        paint(from, end, 'idle');
        const toolLimitAt = current && Array.isArray(row?.tools) && row.tools.length === 0
          ? (run.length ? eventTime(run.at(-1)) + ttlMs : end) : end;
        for (const [from, to] of workingHistory(run, end, { ttlMs, toolLimitAt }).intervals) paint(from, to, 'busy');
      }
      for (const event of run) {
        if (WAIT_TYPES.has(event.event_type)) paint(event.at, event.at, 'waiting');
        if (ERROR_TYPES.has(event.event_type)) paint(event.at, event.at, 'error');
      }
    }
  }
  for (const message of inbound) {
    if (!currentRuns.has(message.session_group)) continue;
    const at = milliseconds(message.timestamp);
    if (Number.isFinite(at) && at >= start && at <= now) groups[message.session_group].inbound.push(at);
  }
  for (const group of Object.values(groups)) group.inbound.sort((a, b) => a - b);
  return { range, cellSeconds: spec.seconds, start, groups };
}
