import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isoTimestamp, projectApiTimestamps, projectEventTimestamps } from '../wire-time.js';
import { sendJson } from '../http.js';
import { SseHub } from '../sse.js';

const at = Date.UTC(2026, 10, 16, 2, 3, 4);
const iso = new Date(at).toISOString();

test('explicit time units normalize numeric, SQLite and ISO values without guessing magnitudes', () => {
  assert.equal(isoTimestamp(at), iso);
  assert.equal(isoTimestamp(at / 1000, 's'), iso);
  assert.equal(isoTimestamp(String(at)), iso);
  assert.equal(isoTimestamp(at / 86400000 + 2440587.5, 'julian'), iso);
  assert.equal(isoTimestamp('2026-11-16 02:03:04'), iso);
  assert.equal(isoTimestamp('2026-11-16T10:03:04+08:00'), iso);
  for (const value of [null, undefined, '', 0, '0']) for (const unit of ['ms', 's', 'julian']) assert.equal(isoTimestamp(value, unit), null);
  assert.equal(isoTimestamp(Infinity), null);
  assert.equal(isoTimestamp('unreadable'), null);
});

test('instance and group projections convert exact evidence fields while preserving internal models', () => {
  const instance = { resources: { sampledAt: at, cpu_pct: 10 }, accounts: { codex: { recordedAt: at, resetsAt: at / 1000 } },
    runtimeHealth: { codex: { cooldownUntil: at / 1000, updatedAt: at } }, session_mode: {
      transition: { createdAt: at / 1000, updatedAt: at / 1000, cutoff: 1700000000 },
      blocked: { since: at }, lastCompleted: { updatedAt: at / 1000 }, lastEvents: [{ ts: at }] } };
  const result = projectApiTimestamps('/api/instance', instance);
  assert.equal(result.resources.sampledAt, iso);
  assert.equal(result.accounts.codex.resetsAt, iso);
  assert.equal(result.accounts.codex.recordedAt, iso);
  assert.equal(result.runtimeHealth.codex.cooldownUntil, iso);
  assert.equal(result.runtimeHealth.codex.updatedAt, iso);
  assert.equal(result.session_mode.transition.createdAt, iso);
  assert.equal(result.session_mode.transition.cutoff, 1700000000);
  assert.equal(result.session_mode.blocked.since, iso);
  assert.equal(result.session_mode.lastEvents[0].ts, iso);
  assert.equal(instance.resources.sampledAt, at);
  const group = { readAt: at, createdAt: at / 1000, duration: 123,
    state: { kind: 'working', sampledAt: at }, live: { status: { sampledAt: at } },
    c4: { lastActivityAt: at }, preview: { timestamp: at, text: 'createdAt: 123' },
    fence: { createdAt: at / 1000 }, wait: { since: at / 1000, cooldownUntil: at / 1000 },
    queue: { pending: { oldestAt: at } }, working: { since: at, subagents: { since: at, lastActivityAt: at } } };
  const projected = projectApiTimestamps('/api/groups/origin', group);
  assert.equal(projected.createdAt, iso);
  assert.equal(projected.live.status.sampledAt, iso);
  assert.equal(projected.wait.since, iso);
  assert.equal(projected.working.subagents.lastActivityAt, iso);
  assert.equal(projected.duration, 123);
  assert.equal(projected.preview.text, group.preview.text);
  assert.equal(projectApiTimestamps('/api/groups/running', { readAt: at, rows: [group] }).rows[0].queue.pending.oldestAt, iso);
  assert.deepEqual(projectApiTimestamps('/api/groups/activity', { start: at, cellSeconds: 60, groups: { origin: { inbound: [at] } } }),
    { start: iso, cellSeconds: 60, groups: { origin: { inbound: [iso] } } });
});

test('schedule list, detail, history, preview and command times use ISO while cursors and durations stay opaque', () => {
  const task = { nextRunAt: at / 1000, lastRunAt: at / 1000, updatedAt: at / 1000, intervalSeconds: 3600,
    recent: [{ executedAt: at / 1000, completedAt: at / 1000, duration: 123 }], nextRuns: { runs: [at / 1000], in24h: [at / 1000] } };
  const list = projectApiTimestamps('/api/schedules', { readAt: at, tasks: [task], timelineTasks: [task], nextCursor: 'opaque' });
  assert.equal(list.readAt, iso);
  assert.equal(list.tasks[0].nextRunAt, iso);
  assert.equal(list.timelineTasks[0].recent[0].executedAt, iso);
  assert.equal(list.tasks[0].nextRuns.runs[0], iso);
  assert.equal(list.tasks[0].intervalSeconds, 3600);
  assert.equal(list.tasks[0].recent[0].duration, 123);
  assert.equal(task.nextRunAt, at / 1000);
  assert.equal(projectApiTimestamps('/api/schedules/task-1', { task }).task.updatedAt, iso);
  assert.deepEqual(projectApiTimestamps('/api/schedules/preview', { valid: true, runs: [at / 1000] }), { valid: true, runs: [iso] });
  assert.deepEqual(projectApiTimestamps('/api/schedules/task-1/history', { rows: task.recent, next: { before: at / 1000, beforeId: 42 } }),
    { rows: [{ executedAt: iso, completedAt: iso, duration: 123 }], next: { before: at / 1000, beforeId: 42 } });
  assert.equal(projectApiTimestamps('/api/schedules', { ok: false, nextRunAt: at / 1000 }).nextRunAt, iso);
  assert.equal(projectApiTimestamps('/api/schedules', { ok: true, data: { task: { next_run_at: at / 1000 } } }).data.task.next_run_at, iso);
});

test('chat, observer, fleet and key projections keep user content and identifiers opaque', () => {
  const chat = { items: [{ id: 1700000000, stamp: at / 86400000 + 2440587.5, timestamp: at,
    quote: { timestamp: at }, content: { timestamp: at, createdAt: at } }], nextCursor: 'opaque' };
  const projected = projectApiTimestamps('/api/chat/conversations', chat);
  assert.equal(projected.items[0].stamp, iso);
  assert.equal(projected.items[0].timestamp, iso);
  assert.equal(projected.items[0].quote.timestamp, iso);
  assert.deepEqual(projected.items[0].content, chat.items[0].content);
  assert.equal(projected.items[0].id, 1700000000);
  assert.equal(projectApiTimestamps('/api/observer/leases', { expiresAt: at }).expiresAt, iso);
  assert.equal(projectApiTimestamps('/api/keys', { keys: [{ created_at: '2026-11-16 02:03:04' }] }).keys[0].created_at, iso);
  assert.equal(projectApiTimestamps('/api/fleet', { self: { system_metrics: { sampledAt: at } }, agents: [{ rate_limit_7d_recorded_at: at }] }).agents[0].rate_limit_7d_recorded_at, iso);
});

test('HTTP and SSE use the same immutable wire projection', () => {
  const data = { readAt: at, running: { total: 1 } };
  const response = { apiPath: '/api/groups/counts', writeHead() {}, end(body) { this.body = JSON.parse(body); } };
  sendJson(response, 200, data);
  assert.equal(response.body.readAt, iso);
  const res = new EventEmitter();
  const chunks = [];
  res.writeHead = () => {};
  res.write = text => { chunks.push(text); return true; };
  res.end = () => {};
  const hub = new SseHub();
  hub.addClient(res);
  hub.broadcast('groups', data);
  hub.closeAll();
  const frame = chunks.find(value => value.includes('event: groups'));
  assert.deepEqual(JSON.parse(frame.match(/data: (.*)/)[1]), response.body);
  assert.equal(data.readAt, at);
  assert.equal(projectEventTimestamps('metric_update', { timestamp: at }).timestamp, iso);
  assert.equal(projectEventTimestamps('metric_update', { dimensions: { rate_limit_7d_resets_at: at / 1000 } }).dimensions.rate_limit_7d_resets_at, iso);
});

test('zero clocks are unknown and event, Git and preview fields normalize actual producers', () => {
  const instance = projectApiTimestamps('/api/instance', { runtimeHealth: { claude: { updatedAt: at, cooldownUntil: 0 } } });
  assert.equal(instance.runtimeHealth.claude.updatedAt, iso);
  assert.equal(instance.runtimeHealth.claude.cooldownUntil, null);
  assert.equal(projectApiTimestamps('/api/chat/conversations', { items: [{ stamp: 0 }] }).items[0].stamp, null);
  const event = projectApiTimestamps('/api/groups/origin/events', { events: [{ metadata: { pasted_at: at, source_time: 9, received_at: 8 } }] });
  assert.equal(event.events[0].metadata.pasted_at, iso);
  assert.equal(event.events[0].metadata.source_time, 9);
  assert.equal(event.events[0].metadata.received_at, 8);
  assert.equal(projectApiTimestamps('/api/memory/git', { commit: { author_date: '2026-11-16T10:03:04+08:00' } }).commit.author_date, iso);
  assert.equal(projectApiTimestamps('/api/schedules/preview', { iso: '2026-11-16T10:03:04+08:00' }).iso, iso);
});


test('Fleet attention recovery times use ISO in local and remote HTTP and SSE records', () => {
  const record = { group_summary: { attention: [
    { kind: 'rate_limited', until: at / 1000 },
    { kind: 'rate_limited', until: 0 },
    { kind: 'channel_restarting', count: 3 },
  ] } };
  const payload = { self: record, agents: [record] };
  for (const result of [projectApiTimestamps('/api/fleet', payload), projectEventTimestamps('fleet', payload)]) {
    for (const item of [result.self, result.agents[0]]) {
      assert.equal(item.group_summary.attention[0].until, iso);
      assert.equal(item.group_summary.attention[1].until, null);
      assert.deepEqual(item.group_summary.attention[2], { kind: 'channel_restarting', count: 3 });
    }
  }
  assert.equal(projectApiTimestamps('/api/fleet/agents/peer', record).group_summary.attention[0].until, iso);
  assert.equal(record.group_summary.attention[0].until, at / 1000);
});
