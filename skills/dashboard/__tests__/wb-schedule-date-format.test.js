import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleRead, nextRuns } from '../src/lib/workbench/schedule-read.js';
import { createScheduleTz, dateKey, localToOffsetIso } from '../src/lib/workbench/schedule-tz.js';
import { dayBoundsUTC } from '../src/lib/metric-resolver.js';
import { usageIntervals } from '../src/lib/workbench/cost-query.js';
import { cachedFormatterCount, MAX_CACHED_FORMATTERS } from '../src/lib/date-format-cache.js';
import { createCronIterator } from '../../scheduler/scripts/cron-utils.js';
import { scheduleEnv } from './fixtures/schedule-env.js';

const DAY = 86400;
const ZONES = ['Asia/Singapore', 'America/New_York'];
// 2027-11-10T12:00:00Z: the seven-day window contains New York's 2027-11-07 fall-back change.
const NOW = Date.UTC(2027, 10, 10, 12) / 1000;
const TZ_URL = new URL('../../scheduler/scripts/tz.js', import.meta.url).href;
let importCase = 0;

/** Counts Intl.DateTimeFormat constructions (with or without `new`) while `action` runs, then restores the global. */
async function countFormatters(action) {
  const Original = Intl.DateTimeFormat;
  let count = 0;
  function Counting(...args) {
    count++;
    return new Original(...args);
  }
  Counting.prototype = Original.prototype;
  Counting.supportedLocalesOf = Original.supportedLocalesOf;
  Intl.DateTimeFormat = Counting;
  try {
    const result = await action();
    return { result, count };
  } finally {
    Intl.DateTimeFormat = Original;
  }
}

const freshDate = (epoch, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(epoch * 1000));

/** Local midnights (epoch seconds) of the dates around NOW in `tz`, found by second-level search. */
function localMidnights(tz) {
  const marks = [];
  for (let at = NOW - 9 * DAY; at <= NOW + DAY; at += 3600) {
    if (freshDate(at - 3600, tz) !== freshDate(at, tz)) {
      let low = at - 3600, high = at;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (freshDate(middle, tz) === freshDate(at, tz)) high = middle; else low = middle;
      }
      marks.push(high);
    }
  }
  return marks;
}

test('cached calendar dates equal a fresh formatter around midnights and daylight saving changes', () => {
  for (const tz of ZONES) {
    const instants = [];
    for (const midnight of localMidnights(tz)) instants.push(midnight - 1, midnight, midnight + 1);
    for (let at = NOW - 9 * DAY; at <= NOW + DAY; at += 1800) instants.push(at);
    for (const at of instants) {
      const expected = freshDate(at, tz);
      if (dateKey(at, tz) !== expected) assert.fail(`${tz} ${at}: ${dateKey(at, tz)} !== ${expected}`);
    }
  }
  // New York: the last second of 2027-11-06 (EDT) and the 25-hour day of 2027-11-07.
  assert.equal(dateKey(Date.UTC(2027, 10, 7, 3, 59, 59) / 1000, 'America/New_York'), '2027-11-06');
  assert.equal(dateKey(Date.UTC(2027, 10, 7, 4) / 1000, 'America/New_York'), '2027-11-07');
  assert.equal(dateKey(Date.UTC(2027, 10, 8, 4, 59, 59) / 1000, 'America/New_York'), '2027-11-07');
  assert.equal(dateKey(Date.UTC(2027, 10, 8, 5) / 1000, 'America/New_York'), '2027-11-08');
  assert.equal(dateKey(Date.UTC(2027, 10, 9, 15, 59, 59) / 1000, 'Asia/Singapore'), '2027-11-09');
  assert.equal(dateKey(Date.UTC(2027, 10, 9, 16) / 1000, 'Asia/Singapore'), '2027-11-10');
  // Offsets on both sides of a change are unaffected by reusing the formatter.
  assert.equal(localToOffsetIso('2027-11-06T23:59:59', 'America/New_York').iso, '2027-11-06T23:59:59-04:00');
  assert.equal(localToOffsetIso('2027-11-08T00:00', 'America/New_York').iso, '2027-11-08T00:00:00-05:00');
  assert.equal(localToOffsetIso('2027-11-10T00:00', 'Asia/Singapore').iso, '2027-11-10T00:00:00+08:00');
});

test('calendar helpers build one formatter per zone however many instants they format', async () => {
  const instants = Array.from({ length: 5000 }, (_, i) => NOW - i * 157);
  for (const tz of ['Europe/Berlin', 'Australia/Adelaide']) {
    const first = await countFormatters(() => instants.map(at => dateKey(at, tz)));
    assert.equal(first.count, 1);
    const again = await countFormatters(() => instants.map(at => dateKey(at, tz)));
    assert.equal(again.count, 0);
  }
  // A minute-step rule checks every candidate minute with one formatter, across tasks.
  const tasks = Array.from({ length: 20 }, () => ({ status: 'pending', type: 'recurring', cron_expression: '*/7 * * * *' }));
  const cron = { createCronIterator };
  const runs = await countFormatters(() => tasks.map(task => nextRuns(task, 5, NOW, 'Asia/Kolkata', cron, { until: NOW + DAY })));
  assert.equal(new Set(runs.result.map(list => JSON.stringify(list))).size, 1);
  // The cron library builds its own per-zone formatters once; the minute check adds one, not one per task.
  assert.ok(runs.count <= 4, `${runs.count} formatters for ${tasks.length} tasks`);
  const more = await countFormatters(() => tasks.map(task => nextRuns(task, 5, NOW, 'Asia/Kolkata', cron, { until: NOW + DAY })));
  assert.equal(more.count, 0);
  // Usage day buckets: a year of buckets reuses one formatter.
  const year = await countFormatters(() => usageIntervals({ since: '2026-11-10T00:00:00.000Z',
    until: '2027-11-10T00:00:00.000Z', bucket: 'day', tz: 'America/Chicago' }));
  assert.ok(year.result.length >= 365);
  assert.equal(year.count, 1);
  const bounds = await countFormatters(() => dayBoundsUTC('America/Chicago', 6, new Date(NOW * 1000)));
  assert.equal(bounds.count, 0);
  assert.deepEqual(bounds.result, { since: '2027-11-04T05:00:00.000Z', until: '2027-11-10T12:00:00.000Z' });
});

test('the formatter cache stays within its fixed limit for many distinct zones and keeps reusing', async () => {
  assert.equal(MAX_CACHED_FORMATTERS, 64);
  const offsets = [];
  for (let minutes = -720; minutes <= 840 && offsets.length < 400; minutes += 7) {
    const sign = minutes < 0 ? '-' : '+', abs = Math.abs(minutes);
    offsets.push(`${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`);
  }
  assert.equal(offsets.length, 223);
  const at = NOW - 3600;
  let peak = 0;
  const built = await countFormatters(() => {
    for (const tz of offsets) {
      const expected = freshDate(at, tz);
      if (dateKey(at, tz) !== expected) assert.fail(`${tz}: ${dateKey(at, tz)} !== ${expected}`);
      peak = Math.max(peak, cachedFormatterCount());
    }
  });
  // freshDate builds one per zone for comparison; dateKey adds one per zone not yet cached.
  assert.equal(built.count, offsets.length * 2);
  assert.ok(peak <= MAX_CACHED_FORMATTERS, `${peak} cached formatters`);
  assert.ok(cachedFormatterCount() <= MAX_CACHED_FORMATTERS);
  // After the cache was emptied and refilled, a recent zone is still reused across many instants.
  const recent = offsets.at(-1);
  const reuse = await countFormatters(() => Array.from({ length: 2000 }, (_, i) => dateKey(NOW - i * 97, recent)));
  assert.equal(reuse.count, 0);
  assert.equal(reuse.result[0], freshDate(NOW, recent));
  // An emptied zone is rebuilt once, with the same result.
  const first = offsets[0];
  const again = await countFormatters(() => Array.from({ length: 2000 }, (_, i) => dateKey(at - i * 97, first)));
  assert.equal(again.count, 1);
  assert.equal(again.result[0], freshDate(at, first));
  assert.ok(cachedFormatterCount() <= MAX_CACHED_FORMATTERS);
});

// Integration: real read-only SQLite read of a temporary scheduler.db holding about
// 40,000 history rows, with the real scheduler tz/cron modules. Covers the schedule
// overview's seven-day statistics and upcoming-run previews: run when the schedule
// read model or its calendar helpers change; skip for rendering-only edits.
// Isolation: scheduleEnv gives a temporary HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR
// and tmux directory (paths asserted under the fixture root and printed); no PM2,
// tmux server, network or live Zylos access. process.env.ZYLOS_DIR points at the
// fixture during the read and is restored; teardown removes the fixture root.
function seeded(t, tz, rows) {
  const f = scheduleEnv(t, { tz });
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = f.zylosDir;
  t.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
  });
  assert.equal(f.agent(['list']).ok, undefined);
  const db = f.open();
  const insertTask = db.prepare(`INSERT INTO tasks (id, name, prompt, type, cron_expression, interval_seconds, timezone,
    next_run_at, priority, status, require_idle, miss_threshold, created_at, updated_at)
    VALUES (?, ?, 'Check.', ?, ?, ?, ?, ?, 3, ?, 0, 300, ?, ?)`);
  const kinds = [['recurring', '*/7 * * * *', null], ['recurring', '0 8 * * *', null], ['interval', null, 3600], ['one-time', null, null]];
  db.exec('BEGIN');
  for (let i = 0; i < 12; i++) {
    const [type, cron, interval] = kinds[i % kinds.length];
    insertTask.run(`task-${i}`, `Task ${i}`, type, cron, interval, tz, NOW + 600 + i * 60,
      i === 11 ? 'paused' : 'pending', NOW - 30 * DAY, NOW - DAY);
  }
  db.exec('COMMIT');
  const insertRun = db.prepare('INSERT INTO task_history (task_id, executed_at, completed_at, status, duration_ms) VALUES (?, ?, ?, ?, ?)');
  const history = [];
  const add = (at, status) => {
    history.push({ executed_at: at, status });
    insertRun.run(`task-${history.length % 12}`, at, status === 'started' ? null : at + 5, status, status === 'started' ? null : 5000);
  };
  db.exec('BEGIN');
  // Status mix close to a busy instance: mostly success, some failures and timeouts, a few still started.
  for (let i = 0; i < rows; i++) {
    const at = NOW - 8 * DAY + Math.floor((i * 8 * DAY) / rows);
    const pick = (i * 7919) % 100;
    add(at, pick < 88 ? 'success' : pick < 95 ? 'failed' : pick < 98 ? 'timeout' : 'started');
  }
  for (const midnight of localMidnights(tz).filter(at => at > NOW - 8 * DAY && at <= NOW)) {
    add(midnight - 1, 'failed');
    add(midnight, 'timeout');
  }
  db.exec('COMMIT');
  const reader = createScheduleRead({ zylosDir: f.zylosDir, now: () => NOW * 1000,
    scheduleTz: createScheduleTz({ zylosDir: f.zylosDir, tzModule: `${TZ_URL}?case=${++importCase}` }) });
  return { f, reader, history };
}

/** The seven-day statistics recomputed from the inserted rows, independently of the product code. */
function expectedWeek(history, tz) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const date = at => format.format(new Date(at * 1000));
  const days = [];
  for (let back = 6; back >= 0; back--) {
    const key = date(NOW - back * DAY);
    if (!days.some(day => day.date === key)) days.push({ date: key, success: 0, timeout: 0, failed: 0 });
  }
  let runs = 0, bad = 0, success = 0;
  for (const row of history) {
    if (row.executed_at >= NOW - 7 * DAY) {
      runs++;
      if (row.status === 'failed') bad++;
      if (row.status === 'success') success++;
    }
    const day = days.find(item => item.date === date(row.executed_at));
    if (day && ['success', 'timeout', 'failed'].includes(row.status)) day[row.status]++;
  }
  return { days, runs7d: runs, bad7d: bad, successRate7d: success + bad === 0 ? null : success / (success + bad) };
}

test('schedule overview with 40,000 history rows matches recomputed week totals using a fixed number of formatters', { timeout: 120000 }, async t => {
  const reads = [];
  for (const [tz, rows] of [['America/New_York', 100], ['America/New_York', 40000], ['Asia/Singapore', 100], ['Asia/Singapore', 40000]]) {
    const instance = seeded(t, tz, rows);
    const first = await countFormatters(() => instance.reader.read());
    const again = await countFormatters(() => instance.reader.read());
    t.diagnostic(`${tz} ${instance.history.length} rows: ${first.count} formatters on the first read, ${again.count} on the next`);
    // Zone validation and the cron library build a few per read; none depend on history rows.
    assert.ok(first.count <= 8, `${first.count} formatters`);
    assert.equal(JSON.stringify(again.result), JSON.stringify(first.result));
    reads.push({ tz, rows, instance, result: first.result, again: again.count });
  }
  for (const zone of ZONES) {
    const [small, large] = reads.filter(read => read.tz === zone);
    assert.equal(large.again, small.again);
  }
  assert.ok(reads.every(read => read.again <= 2), JSON.stringify(reads.map(read => read.again)));

  for (const { tz, rows, instance, result } of reads) {
    const expected = expectedWeek(instance.history, tz);
    assert.equal(result.tz, tz);
    assert.equal(result.daily7d.tz, tz);
    assert.equal(JSON.stringify(result.daily7d.days), JSON.stringify(expected.days));
    assert.equal(result.kpi.runs7d, expected.runs7d);
    assert.equal(result.kpi.bad7d, expected.bad7d);
    assert.equal(result.kpi.successRate7d, expected.successRate7d);
    assert.equal(result.tasks.length, 12);
    assert.deepEqual(result.daily7d.days.map(day => day.date),
      ['2027-11-04', '2027-11-05', '2027-11-06', '2027-11-07', '2027-11-08', '2027-11-09', '2027-11-10']);
    if (rows === 40000) assert.ok(result.kpi.runs7d > 34000);
  }
});
