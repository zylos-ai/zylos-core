import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionReader } from '../session-state-reader-async.js';
import { UsageMonitor } from '../../../skills/activity-monitor/scripts/usage-monitor.js';
import { readRecordedCodexSample } from '../session-usage-reader.js';
import { performance } from 'node:perf_hooks';

const now = Date.parse('2026-11-10T00:10:00+08:00');
const reset = now / 1000 + 86400;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
  };
  const status = (group, percent, at, resets = reset) => write(`activity-monitor/session-groups/${group}/statusline.json`, {
    session_id: 'session', zylos: { v: 1, runId: 'run', capturedAt: at },
    rate_limits: { seven_day: { used_percentage: percent, resets_at: resets } },
  });
  const identity = { present: true, ready: true, runtime: 'claude', runId: 'run', sessionId: 'session' };
  let live = [], observed = identity, connections = 0, closes = 0;
  const reader = createSessionReader({ env: { ZYLOS_DIR: root }, now: () => now,
    listSessions: async () => live.map(sessionGroup => ({ sessionGroup })),
    open: async () => { connections++; return { close: async () => { closes++; } }; }, observe: async () => observed });
  return { root, write, status, reader, identity, setLive: value => { live = value; },
    setIdentity: value => { observed = value; }, counts: () => [connections, closes] };
}

test('live account values and mtime selection stay unchanged, with opt-in provenance', async t => {
  const f = fixture(t); const a = f.status('origin', 7, now - 5000), b = f.status('other', 12, now - 10000);
  fs.utimesSync(a, 100, 100); fs.utimesSync(b, 200, 200); f.setLive(['origin', 'other']);
  const expected = { seven_day: { used_percentage: 12, resets_at: reset } };
  assert.deepEqual(await f.reader.readAccountUsage('claude'), expected);
  assert.deepEqual(await f.reader.readAccountUsage('claude', null), expected);
  f.write('activity-monitor/usage.json', { lastCheck: new Date(now - 1).toISOString(), weeklyAll: { percent: 99, resets: reset } });
  assert.deepEqual(await f.reader.readAccountUsage('claude', { allowRecorded: true }), { value: expected, recordedAt: now - 10000, live: true });
  assert.deepEqual(f.counts(), [6, 6]);
});

test('reclaimed groups prefer the newest valid group quota over a later sampler copy', async t => {
  const f = fixture(t); const file = f.status('origin', 4, now - 7200000);
  fs.utimesSync(file, now / 1000, now / 1000);
  f.status('other', 7, now - 3600000);
  assert.equal(await f.reader.readAccountUsage('claude'), null);
  const record = await f.reader.readAccountUsage('claude', { allowRecorded: true });
  assert.equal(record.value.seven_day.used_percentage, 7); assert.equal(record.recordedAt, now - 3600000); assert.equal(record.live, false);
  f.write('activity-monitor/usage.json', { lastCheck: new Date(now - 1000).toISOString(), weeklyAll: { percent: 9, resets: new Date(reset * 1000).toISOString() } });
  assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).value.seven_day.used_percentage, 7);
  assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).recordedAt, now - 3600000);
  f.status('newest', 11, now - 500);
  assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).value.seven_day.used_percentage, 11);
  assert.deepEqual(f.counts(), [0, 0], 'history does not open a tmux connection');
});

test('the account sampler is used only when all group samples are absent or invalid', async t => {
  const f = fixture(t);
  f.write('activity-monitor/usage.json', { lastCheck: new Date(now - 1000).toISOString(), weeklyAll: { percent: 8, resets: reset } });
  f.status('expired', 20, now - 500, now / 1000 - 1);
  f.write('activity-monitor/session-groups/broken/statusline.json', '{broken');
  assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).value.seven_day.used_percentage, 8);
  f.status('valid', 20, now - 3600000);
  const record = await f.reader.readAccountUsage('claude', { allowRecorded: true });
  assert.equal(record.value.seven_day.used_percentage, 20);
  assert.equal(record.recordedAt, now - 3600000);
  assert.equal(await f.reader.readAccountUsage('claude', null), null);
});

test('invalid group directory names cannot hide a valid recorded group', async t => {
  const f = fixture(t);
  f.status('.tmp', 99, now - 1);
  f.status('lost+found', 99, now - 1);
  f.status('valid', 20, now - 1000);
  const record = await f.reader.readAccountUsage('claude', { allowRecorded: true });
  assert.equal(record.value.seven_day.used_percentage, 20);
  assert.equal(record.recordedAt, now - 1000);
});

test('recorded Codex reads the newest valid run and stops before older rollouts', t => {
  const f = fixture(t), group = 'codex:history';
  const rollout = (name, percent, at) => f.write(`${name}.jsonl`, JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { secondary: { window_minutes: 10080, used_percent: percent, resets_at: reset } } } }) + '\n');
  const oldFile = rollout('older', 10, now - 5000), newFile = rollout('newer', 20, now - 1000);
  const event = (run, file, ts) => ({ v: 1, ts, event: 'session_start', runtime: 'codex', session_group: group,
    run_id: run, session_id: run, transcript_path: file });
  f.write(`activity-monitor/session-groups/${group}/events.jsonl`, [event('new', newFile, now - 2000), event('old', oldFile, now - 6000)]
    .map(value => JSON.stringify(value)).join('\n') + '\n');
  const opened = [];
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { opened.push(file); return openSync(file, ...args); });
  const record = readRecordedCodexSample({ sessionGroup: group, env: { ZYLOS_DIR: f.root }, now });
  assert.equal(record.sample.rateLimits.sevenDay.usedPercentage, 20);
  assert.equal(record.sample.capturedAt, now - 1000);
  assert.equal(opened.filter(file => file === newFile).length, 1);
  assert.equal(opened.includes(oldFile), false, 'a valid newest run ends the historical scan');
  assert.equal(opened.filter(file => String(file).endsWith('events.jsonl')).length, 1);
});

test('expired Codex history opens only the newest sampled rollout in each group', async t => {
  const f = fixture(t), rollouts = new Set(), newest = new Set();
  let bytes = 0;
  for (const group of ['codex:first', 'codex:second']) {
    const events = [];
    for (let run = 0; run < 31; run++) {
      const at = now - 3600000 + run * 1000;
      const text = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(221500) } }) + '\n' +
        JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count',
          rate_limits: { secondary: { window_minutes: 10080, used_percent: 20, resets_at: now / 1000 - 1 } } } }) + '\n';
      const file = f.write(`${group}/rollout-${run}.jsonl`, text);
      bytes += Buffer.byteLength(text); rollouts.add(file);
      if (run === 30) newest.add(file);
      events.push({ v: 1, ts: at - 1, event: 'session_start', runtime: 'codex', session_group: group,
        run_id: String(run), session_id: String(run), transcript_path: file });
    }
    f.write(`activity-monitor/session-groups/${group}/events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  }
  let opened = [];
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (rollouts.has(file)) opened.push(file); return openSync(file, ...args); });
  const durations = [];
  for (let iteration = 0; iteration < 20; iteration++) {
    opened = [];
    const start = performance.now();
    assert.equal(await f.reader.readAccountUsage('codex', { allowRecorded: true }), null);
    durations.push(performance.now() - start);
    assert.equal(opened.length, 2, 'one sampled rollout per group, even when all windows expired');
    for (const file of opened) assert.ok(newest.has(file), 'older expired rollouts must not be opened');
  }
  const sorted = [...durations].sort((a, b) => a - b);
  console.log('Expired Codex history timing:', JSON.stringify({ fixture: 'synthetic, not copied production data',
    groups: 2, rollouts: rollouts.size, bytes, iterations: durations.length, openedPerRead: 2,
    firstMs: durations[0], minMs: sorted[0], medianMs: (sorted[9] + sorted[10]) / 2,
    maxMs: sorted.at(-1), meanMs: durations.reduce((a, b) => a + b, 0) / durations.length }));
});

test('a Codex token sample ends the group search even without usable quota or timestamp', t => {
  const f = fixture(t), group = 'codex:sample';
  const oldFile = f.write('old.jsonl', JSON.stringify({ timestamp: new Date(now - 10000).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { secondary: { window_minutes: 10080, used_percent: 20, resets_at: reset } } } }) + '\n');
  const newFile = f.write('new.jsonl', '');
  f.write(`activity-monitor/session-groups/${group}/events.jsonl`, [
    { v: 1, ts: now - 20000, event: 'session_start', runtime: 'codex', session_group: group, run_id: 'old', session_id: 'old', transcript_path: oldFile },
    { v: 1, ts: now - 2000, event: 'session_start', runtime: 'codex', session_group: group, run_id: 'new', session_id: 'new', transcript_path: newFile },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const opened = [];
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { opened.push(file); return openSync(file, ...args); });
  for (const timestamp of [new Date(now - 1000).toISOString(), 'invalid']) {
    f.write('new.jsonl', JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count' } }) + '\n');
    assert.equal(readRecordedCodexSample({ sessionGroup: group, env: { ZYLOS_DIR: f.root }, now }), null);
  }
  assert.equal(opened.includes(oldFile), false);
});

test('Codex with no valid run never uses the Claude account sampler', async t => {
  const f = fixture(t);
  f.write('activity-monitor/usage.json', { lastCheck: new Date(now - 1).toISOString(), weeklyAll: { percent: 8, resets: reset } });
  assert.equal(await f.reader.readAccountUsage('codex', { allowRecorded: true }), null);
  f.write('activity-monitor/session-groups/codex:empty/events.jsonl', '');
  assert.equal(await f.reader.readAccountUsage('codex', { allowRecorded: true }), null);
});

test('expired, malformed, future, undated and absent historical records stay unknown', async t => {
  const f = fixture(t);
  assert.equal(await f.reader.readAccountUsage('claude', { allowRecorded: true }), null);
  for (const resets of [now / 1000 - 1, now / 1000, null, 'bad']) {
    f.status('origin', 90, now - 1000, resets);
    assert.equal(await f.reader.readAccountUsage('claude', { allowRecorded: true }), null, String(resets));
  }
  f.status('origin', 90, now + 1);
  assert.equal(await f.reader.readAccountUsage('claude', { allowRecorded: true }), null);
  for (const at of ['bad', null, -1]) {
    f.status('origin', 90, at);
    assert.equal(await f.reader.readAccountUsage('claude', { allowRecorded: true }), null);
  }
  for (const percent of [-1, 101, '7']) {
    f.status('origin', percent, now - 1000);
    assert.equal(await f.reader.readAccountUsage('claude', { allowRecorded: true }), null);
  }
  const legacy = f.write('activity-monitor/session-groups/origin/statusline.json', {
    rate_limits: { seven_day: { used_percentage: 8, resets_at: reset } } });
  fs.utimesSync(legacy, (now - 1000) / 1000, (now - 1000) / 1000);
  assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).recordedAt, now - 1000);
  f.write('activity-monitor/session-groups/origin/statusline.json', '{broken');
  f.write('activity-monitor/usage.json', { lastCheck: 'invalid', weeklyAll: { percent: 99, resets: reset } });
  assert.equal(await f.reader.readAccountUsage('claude', { allowRecorded: true }), null);
  f.status('surviving', 0, now - 1000);
  assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).value.seven_day.used_percentage, 0);
  await assert.rejects(f.reader.readAccountUsage('other', { allowRecorded: true }), /Unknown runtime/);
});

test('starting or mismatched live identities cannot label old statusline data as live', async t => {
  const f = fixture(t); f.status('origin', 4, now - 1000); f.setLive(['origin']);
  for (const identity of [{ ...f.identity, ready: false }, { ...f.identity, sessionId: 'new' }]) {
    f.setIdentity(identity);
    assert.equal(await f.reader.readAccountUsage('claude'), null);
    assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).live, false);
  }
  assert.equal(f.counts()[0], f.counts()[1]);
});

test('recorded Codex quotas follow saved session events and complete rollout samples across old runs', async t => {
  const f = fixture(t), group = 'codex:old';
  const rollout = f.write('old.jsonl', JSON.stringify({ timestamp: new Date(now - 2000).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { secondary: { window_minutes: 10080, used_percent: 17, resets_at: reset } } } }) + '\n');
  const events = [{ v: 1, ts: now - 5000, event: 'session_start', runtime: 'codex', session_group: group, run_id: 'old', session_id: 'saved', transcript_path: rollout },
    { v: 1, ts: now - 1000, event: 'session_start', runtime: 'codex', session_group: group, run_id: 'new', session_id: 'empty', transcript_path: path.join(f.root, 'missing') }];
  f.write(`activity-monitor/session-groups/${group}/events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  assert.equal(await f.reader.readAccountUsage('codex'), null);
  const record = await f.reader.readAccountUsage('codex', { allowRecorded: true });
  assert.deepEqual(record, { value: { sevenDay: { usedPercentage: 17, resetsAt: reset } }, recordedAt: now - 2000, live: false });
  fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { secondary: { window_minutes: 10080, used_percent: 99, resets_at: reset } } } }));
  assert.equal((await f.reader.readAccountUsage('codex', { allowRecorded: true })).value.sevenDay.usedPercentage, 17);
  f.write('activity-monitor/usage.json', { lastCheck: new Date(now - 1).toISOString(), weeklyAll: { percent: 99, resets: reset } });
  assert.equal((await f.reader.readAccountUsage('codex', { allowRecorded: true })).value.sevenDay.usedPercentage, 17, 'Claude sampler is never Codex evidence');
});

test('usage monitor keeps the default live-only interface even when recorded quota exists', async t => {
  const f = fixture(t); f.status('origin', 99, now - 1000);
  const calls = [];
  const monitor = new UsageMonitor({ runtimeId: 'claude' }, { usageStateFile: path.join(f.root, 'monitor.json'),
    readAccountUsage: async (...args) => { calls.push(args); return f.reader.readAccountUsage(...args); }, log: () => {} });
  assert.equal(await monitor.runMonitor({ currentTime: now / 1000 }), true);
  assert.deepEqual(calls, [['claude']]); assert.equal(fs.existsSync(path.join(f.root, 'monitor.json')), false);
  assert.equal((await f.reader.readAccountUsage('claude', { allowRecorded: true })).value.seven_day.used_percentage, 99);
});
