import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'dotenv';
import { createInstanceTimezone } from '../src/lib/instance-timezone.js';

const ALL_SERVICES = ['scheduler', 'activity-monitor', 'c4-dispatcher'];

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-timezone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'));
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, options.text ?? 'TZ=UTC\nOTHER=keep\n');
  const processes = ALL_SERVICES.map((name, index) => {
    const script = ['scheduler/scripts/daemon.js', 'activity-monitor/scripts/activity-monitor.js', 'comm-bridge/scripts/c4-dispatcher.js'][index];
    const file = path.join(root, '.claude/skills', script);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
    return { name, pm2_env: { status: 'online', pm_exec_path: file, ZYLOS_DIR: root } };
  });
  const restarted = [], logs = [];
  const timezone = createInstanceTimezone({ zylosDir: root,
    readTimezone: () => parse(fs.readFileSync(envFile)).TZ || 'UTC',
    readPm2: async () => ({ processes }), restartService: async (...args) => { restarted.push(args); },
    log: message => logs.push(message), ...options.dependencies });
  return { root, envFile, processes, restarted, logs, timezone,
 };
}

test('invalid timezone and unknown fields cannot change the environment', async t => {
  const f = fixture(t, { dependencies: { zoneinfoDir: null } }), original = fs.readFileSync(f.envFile, 'utf8');
  for (const body of [{ tz: 'Not/AZone' }, { tz: 'asia/tokyo' }, { tz: '+08:00' }, { tz: '-05:30' }, { tz: 'Japan' }, { tz: 'US/Eastern' }, { tz: 'Asia/Calcutta' }, { tz: 'Europe/Kiev' }, { tz: '' }, { tz: ' UTC' }, { tz: 'UTC', command: 'bad' }, null]) {
    await assert.rejects(f.timezone.save(body), { code: 'invalid_timezone', status: 400 });
  }
  assert.equal(fs.readFileSync(f.envFile, 'utf8'), original); assert.equal(f.restarted.length, 0);
});

test('saving preserves unrelated bytes and private permissions without restarting', async t => {
  const f = fixture(t, { text: '# keep\r\nTZ="UTC" # local\r\nSECRET=do-not-log\r\n' });
  const result = await f.timezone.save({ tz: 'Europe/London' });
  assert.equal(result.changed, true); assert.equal(result.previous, 'UTC'); assert.equal(result.tz, 'Europe/London');
  assert.equal(fs.readFileSync(f.envFile, 'utf8'), '# keep\r\nTZ="Europe/London" # local\r\nSECRET=do-not-log\r\n');
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600); assert.equal(f.restarted.length, 0);
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0].includes('do-not-log'), false);
  const unchanged = await f.timezone.save({ tz: 'Europe/London' });
  assert.equal(unchanged.changed, false); assert.equal(unchanged.restart_services.length, 3);
});

test('confirmed restart uses only current owned candidates and preserves partial failures', async t => {
  const calls = [];
  const f = fixture(t, { dependencies: { restartService: async (name, tz) => { calls.push([name, tz]); if (name === 'activity-monitor') throw Error('private output'); } } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES });
  assert.equal(result.ok, false); assert.equal(result.status, 502); assert.equal(result.error, 'restart_failed');
  assert.deepEqual(result.restarted, ['scheduler', 'c4-dispatcher']);
  assert.deepEqual(result.failed, [{ name: 'activity-monitor', error: 'restart_failed' }]);
  assert.deepEqual(result.restart_services, [{ name: 'activity-monitor', status: 'online' }]);
  assert.equal(calls.length, 3); assert.equal(calls.every(item => item[1] === 'UTC'), true);
});

test('concurrent timezone saves preserve the other environment assignments', async t => {
  const f = fixture(t, { text: 'TZ=UTC\nOTHER="keep # literal" # comment\n' });
  await Promise.all(Array.from({ length: 20 }, (_, index) => f.timezone.save({ tz: index % 2 ? 'Asia/Tokyo' : 'Europe/London' })));
  const text = fs.readFileSync(f.envFile, 'utf8');
  assert.equal(text.split('\n').filter(line => line.startsWith('TZ=')).length, 1);
  assert.equal(text.includes('OTHER="keep # literal" # comment\n'), true);
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600);
});

test('dispatcher restart uses the delivery drain timeout without injecting caller environment', async t => {
  const calls = [];
  const f = fixture(t, { dependencies: { restartService: undefined, execute: async (command, options) => { calls.push({ command, options }); } } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ['c4-dispatcher'] });
  assert.equal(result.ok, true); assert.deepEqual(result.restarted, ['c4-dispatcher']);
  assert.equal(calls[0].command, 'pm2 restart "c4-dispatcher" --kill-timeout 10000 2>/dev/null');
  assert.equal(Object.hasOwn(calls[0].options, 'env'), false);
});
