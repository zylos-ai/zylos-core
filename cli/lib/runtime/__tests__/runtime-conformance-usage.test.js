import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupRunDir } from '../../session-group-paths.js';
import { getRuntime } from '../index.js';

function recordedSample(runtime, filename) {
  const directory = new URL(`./samples/${runtime}/usage/`, import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', directory), 'utf8'));
  assert.ok(Object.hasOwn(manifest.files, filename), `manifest must describe ${filename}`);
  return fs.readFileSync(new URL(filename, directory), 'utf8');
}

function usageGroup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root };
  const sessionGroup = 'origin';
  const runDir = groupRunDir(sessionGroup, env);
  fs.mkdirSync(runDir, { recursive: true });
  return { root, env, sessionGroup, runDir };
}

test('Claude subscription quota is available from live, recorded and health statusLine reads', async t => {
  const { env, sessionGroup, runDir } = usageGroup(t);
  const raw = recordedSample('claude', 'statusline.json');
  const sample = JSON.parse(raw);
  fs.writeFileSync(path.join(runDir, 'statusline.json'), raw);
  const { session_id: sessionId, zylos: { runId, capturedAt }, rate_limits: rateLimits } = sample;
  assert.ok(Number.isFinite(rateLimits.five_hour.used_percentage));
  assert.ok(Number.isFinite(rateLimits.seven_day.used_percentage));
  assert.ok(Number.isSafeInteger(capturedAt));

  const { accountQuota, healthQuota } = (await getRuntime('claude')).usage;
  const identity = { present: true, ready: true, runtime: 'claude', runId, sessionId };
  const live = accountQuota.readLiveSample({ sessionGroup, identity, env });
  assert.deepEqual(live.value, rateLimits);
  assert.equal(live.recordedAt, capturedAt);
  assert.deepEqual(accountQuota.readRecordedSample({ sessionGroup, env, now: capturedAt }),
    { value: rateLimits, recordedAt: capturedAt });
  assert.deepEqual(healthQuota({ runDir, runId, sessionId }), { observedAt: capturedAt, rateLimits });
});

test('Codex subscription quota maps recorded windows by duration for both live and recorded reads', async t => {
  const { root, env, sessionGroup, runDir } = usageGroup(t);
  const raw = recordedSample('codex', 'rollout.jsonl');
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, raw);
  const token = raw.trimEnd().split('\n').map(line => JSON.parse(line)).findLast(row =>
    row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.rate_limits);
  const recordedAt = Date.parse(token.timestamp);
  assert.ok(Number.isSafeInteger(recordedAt));
  const nativeWindows = Object.values(token.payload.rate_limits);
  const expected = {};
  for (const [minutes, key] of [[300, 'fiveHour'], [10080, 'sevenDay']]) {
    const window = nativeWindows.find(value => value?.window_minutes === minutes);
    if (!window) continue;
    expected[key] = { usedPercentage: window.used_percent };
    if (Number.isFinite(window.resets_at)) expected[key].resetsAt = window.resets_at;
  }
  assert.ok(Number.isFinite(expected.sevenDay?.usedPercentage));

  const identity = { present: true, ready: true, runtime: 'codex', runId: 'run', sessionId: 'session' };
  const event = { v: 1, ts: recordedAt, event: 'session_start', runtime: identity.runtime,
    session_group: sessionGroup, run_id: identity.runId, session_id: identity.sessionId, transcript_path: rollout };
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify(event) + '\n');
  const { accountQuota } = (await getRuntime('codex')).usage;
  const live = accountQuota.readLiveSample({ sessionGroup, identity, env });
  assert.deepEqual(live.value, expected);
  assert.equal(live.recordedAt, recordedAt);
  assert.deepEqual(accountQuota.readRecordedSample({ sessionGroup, env, now: recordedAt }),
    { value: expected, recordedAt });
});
