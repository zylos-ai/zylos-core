import test from 'node:test';
import assert from 'node:assert/strict';
import { instantMs, instantSeconds, scheduleTimes, activityTimes, conversationStampMs } from '../public/js/wb/api-time.js';
import { dayTime, untilText, formatTime } from '../public/js/wb/schedule.js';
import { localInputValue } from '../public/js/wb/schedule-form.js';
import { recoveryTime } from '../public/js/wb/cooldown.js';
import { systemItems, quotaRecordedTime } from '../public/js/wb/instance-strip.js';
import { statusAnnotation } from '../public/js/wb/board.js';
import { activityStrip } from '../public/js/wb/activity-strip.js';
import { createDocument } from './fixtures/workbench-dom.js';
import { projectApiTimestamps } from '../src/lib/wire-time.js';
import { workbenchAnswer } from './fixtures/workbench-browser-api.js';

const iso = '2026-11-16T09:00:00.000+08:00', ms = Date.parse(iso), seconds = ms / 1000;

test('ISO offset instants parse without converting durations or opaque schedule cursors', () => {
  assert.equal(instantMs(iso), ms); assert.equal(instantSeconds(iso), seconds);
  assert.ok(Number.isNaN(instantMs('not a timestamp')));
  const wire = { readAt: iso, tasks: [{ nextRunAt: iso, recent: [{ executedAt: iso, completedAt: iso, duration: 1200 }],
    nextRuns: { runs: [iso], in24h: [iso] } }], rows: [{ executedAt: iso }], runs: [iso], next: { before: seconds, beforeId: 42 } };
  const data = scheduleTimes(wire);
  assert.equal(data.readAt, ms); assert.equal(data.tasks[0].nextRunAt, seconds);
  assert.equal(data.tasks[0].recent[0].duration, 1200); assert.equal(data.tasks[0].recent[0].executedAt, seconds);
  assert.deepEqual(data.tasks[0].nextRuns, { runs: [seconds], in24h: [seconds] });
  assert.deepEqual(data.next, wire.next); assert.deepEqual(data.runs, [seconds]);
  assert.equal(data.rows[0].executedAt, seconds); assert.equal(wire.tasks[0].nextRunAt, iso);
});

test('schedule labels and input clocks accept ISO offsets', () => {
  assert.equal(formatTime(iso, 'Asia/Singapore', 'en'), formatTime(seconds, 'Asia/Singapore', 'en'));
  assert.equal(dayTime(iso, { tz: 'Asia/Singapore', nowMs: ms }), dayTime(seconds, { tz: 'Asia/Singapore', nowMs: ms }));
  assert.equal(untilText(iso, ms - 60000), untilText(seconds, ms - 60000));
  assert.equal(localInputValue(iso, 'Asia/Singapore'), '2026-11-16T09:00');
});

test('first-step sample freshness, activity markers, recovery and account times accept ISO wire fields', () => {
  const doc = createDocument();
  const fresh = { sampledAt: iso, cpu_pct: 12, mem_total_bytes: 100, mem_used_bytes: 24, disk_pct: 30 };
  const items = systemItems(doc, fresh, { readAt: iso });
  assert.ok(items.every(item => !item.classList.contains('wb-stale')));
  assert.equal(items[0].children.at(-1).textContent, '12%');
  assert.notEqual(statusAnnotation({ state: { sampledAt: iso, stale: true } }, { now: ms + 3000 }).age, '');
  const strip = activityStrip(doc, { start: iso, cellSeconds: 60, cells: ['idle'], inbound: [iso] });
  assert.equal(strip.children[0].classList.contains('wb-inbound'), true);
  assert.equal(recoveryTime(iso, ms - 1), ms);
  assert.notEqual(quotaRecordedTime({ live: false, recordedAt: iso }, ms), null);
});

test('conversation metadata converts ISO activity clocks while preserving time spans and Julian list compatibility', () => {
  const activity = activityTimes({ now: iso, from: iso, steps: [{ start: iso, end: iso, duration: 8 }], awaiting: { since: iso, delivered: iso },
    working: { main: { since: iso } }, header: { readAt: iso } });
  assert.equal(activity.now, ms); assert.equal(activity.steps[0].start, ms); assert.equal(activity.steps[0].duration, 8);
  assert.equal(activity.awaiting.delivered, ms); assert.equal(activity.working.main.since, ms);
  assert.equal(conversationStampMs(iso), ms);
  assert.ok(Math.abs(conversationStampMs(ms / 86400000 + 2440587.5) - ms) < 1);
});

test('browser fixture resources expose the actual ISO wire projection', () => {
  const counts = workbenchAnswer(new URL('/api/groups/counts', 'http://fixture'), ms);
  assert.equal(typeof counts.readAt, 'string'); assert.equal(Date.parse(counts.readAt), ms);
  const schedule = projectApiTimestamps('/api/schedules', { tasks: [{ nextRunAt: seconds }], readAt: ms });
  assert.equal(scheduleTimes(schedule).tasks[0].nextRunAt, seconds);
});
