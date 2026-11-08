import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'dotenv';
import { createInstanceTimezone, replaceTimezoneValue } from '../src/lib/instance-timezone.js';
import { isValidTimezone } from '../../scheduler/scripts/tz.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-timezone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'));
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, options.text ?? 'TZ=UTC\nOTHER=keep\n');
  const processes = ['scheduler', 'web-console', 'zylos-openmax'].map((name, index) => {
    const script = ['scheduler/scripts/daemon.js', 'web-console/scripts/server.js', 'openmax/src/comm-bridge.js'][index];
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
    config(value) { fs.writeFileSync(path.join(root, '.zylos/config.json'), typeof value === 'string' ? value : JSON.stringify(value)); } };
}

for (const [name, input, expected] of [
  ['unquoted comments', '# note\nTZ = UTC  # zone\nOTHER=secret\n', '# note\nTZ = Europe/London  # zone\nOTHER=secret\n'],
  ['double quotes and CRLF', ' export TZ = "UTC" # zone\r\nOTHER="a"\r\n', ' export TZ = "Europe/London" # zone\r\nOTHER="a"\r\n'],
  ['single quotes', "TZ='UTC' # zone\n", "TZ='Europe/London' # zone\n"],
  ['backticks', 'TZ=`UTC` # zone\n', 'TZ=`Europe/London` # zone\n'],
  ['last duplicate only', 'TZ=UTC\nTZ="Asia/Tokyo" # current\n', 'TZ=UTC\nTZ="Europe/London" # current\n'],
  ['multiline other value', 'OTHER="start\nTZ=Asia/Tokyo\nend"\nTZ=UTC\n', 'OTHER="start\nTZ=Asia/Tokyo\nend"\nTZ=Europe/London\n'],
  ['multiline current value', 'TZ="bad\nzone" # repair\n', 'TZ="Europe/London" # repair\n'],
  ['absent assignment', 'OTHER=keep', 'OTHER=keep\nTZ=Europe/London\n'],
  ['empty assignment', 'TZ= # repair\n', 'TZ= Europe/London# repair\n'],
  ['colon assignment', 'TZ: UTC # zone\n', 'TZ: Europe/London # zone\n'],
]) test(`timezone replacement preserves ${name}`, () => {
  const actual = replaceTimezoneValue(input, 'Europe/London');
  assert.equal(actual, expected);
  assert.equal(parse(actual).TZ, 'Europe/London');
});

test('shared timezone validator accepts an IANA zone and rejects an unknown zone', () => {
  assert.equal(isValidTimezone('Asia/Singapore'), true);
  assert.equal(isValidTimezone('Not/AZone'), false);
});

test('invalid timezone and unknown fields cannot change the environment', async t => {
  const f = fixture(t), original = fs.readFileSync(f.envFile, 'utf8');
  for (const body of [{ tz: 'Not/AZone' }, { tz: '' }, { tz: ' UTC' }, { tz: 'UTC', command: 'bad' }, null]) {
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

test('readable invalid current timezone remains repairable', async t => {
  const f = fixture(t, { text: 'TZ=Not/AZone\nOTHER=keep\n' });
  assert.equal((await f.timezone.get()).tz, null); assert.equal((await f.timezone.get()).writable, true);
  assert.equal((await f.timezone.save({ tz: 'UTC' })).previous, null);
});

test('managed deployment and unreadable config fail closed', async t => {
  const f = fixture(t);
  for (const [config, reason, status] of [[{ timezone_managed: true }, 'timezone_managed', 409],
    [{ timezone_managed: 'true' }, 'config_unreadable', 503], ['{bad', 'config_unreadable', 503]]) {
    f.config(config); const view = await f.timezone.get();
    assert.equal(view.writable, false); assert.equal(view.read_only_reason, reason);
    await assert.rejects(f.timezone.save({ tz: 'Europe/London' }), { code: reason, status });
    assert.equal((await f.timezone.restart({ tz: 'UTC', confirm: true })).error, reason);
  }
  f.config({ timezone_managed: false }); assert.equal((await f.timezone.get()).writable, true);
  assert.equal(f.restarted.length, 0);
});

test('read access and nonregular environment are read-only', async t => {
  const f = fixture(t); assert.equal((await f.timezone.get({ canWrite: false })).read_only_reason, 'read_only_access');
  fs.renameSync(f.envFile, `${f.envFile}.original`); fs.symlinkSync(`${f.envFile}.original`, f.envFile);
  assert.equal((await f.timezone.get()).read_only_reason, 'tz_env_read_error');
  await assert.rejects(f.timezone.save({ tz: 'Europe/London' }), { code: 'tz_env_read_error' });
});

test('advisory candidates omit stopped, foreign, duplicate and unrelated processes', async t => {
  const f = fixture(t); f.processes[0].pm2_env.status = 'stopped';
  f.processes[1].pm2_env.ZYLOS_DIR = path.dirname(f.root);
  f.processes.push({ ...f.processes[2] }, { name: 'runtime', pm2_env: { status: 'online' } });
  assert.deepEqual((await f.timezone.get()).restart_services, []);
});

test('candidate ownership can use a verified working directory and deployed script', async t => {
  const f = fixture(t); delete f.processes[0].pm2_env.ZYLOS_DIR; f.processes[0].pm2_env.pm_cwd = f.root;
  assert.equal((await f.timezone.get()).restart_services[0].name, 'scheduler');
  f.processes[0].pm2_env.pm_exec_path = f.processes[1].pm2_env.pm_exec_path;
  assert.equal((await f.timezone.get()).restart_services.some(item => item.name === 'scheduler'), false);
});

test('missing confirmation, injected names and stale timezone never restart', async t => {
  const f = fixture(t);
  for (const body of [{ tz: 'UTC' }, { tz: 'UTC', confirm: false }, { tz: 'UTC', confirm: true, names: ['runtime'] }]) {
    assert.equal((await f.timezone.restart(body)).error, 'confirmation_required');
  }
  assert.equal((await f.timezone.restart({ tz: 'Europe/London', confirm: true })).error, 'timezone_changed');
  assert.equal(f.restarted.length, 0);
});

test('fresh asynchronous discovery is required and errors never reuse an old list', async t => {
  let available = true, calls = 0;
  const f = fixture(t, { dependencies: { readPm2: async () => { calls++; if (!available) throw Error('offline'); return { processes: f.processes }; } } });
  assert.equal((await f.timezone.get()).restart_status, 'known'); available = false;
  assert.equal((await f.timezone.get()).restart_status, 'unknown');
  assert.equal((await f.timezone.restart({ tz: 'UTC', confirm: true })).status, 503);
  assert.equal(f.restarted.length, 0); assert.equal(calls, 3);
});

test('confirmed restart uses only current owned candidates and preserves partial failures', async t => {
  const calls = [];
  const f = fixture(t, { dependencies: { restartService: async (name, tz) => { calls.push([name, tz]); if (name === 'web-console') throw Error('private output'); } } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true });
  assert.equal(result.ok, false); assert.equal(result.status, 200);
  assert.deepEqual(result.restarted, ['scheduler', 'zylos-openmax']);
  assert.deepEqual(result.failed, [{ name: 'web-console', error: 'restart_failed' }]);
  assert.deepEqual(result.restart_services, [{ name: 'web-console', status: 'online' }]);
  assert.equal(calls.length, 3); assert.equal(calls.every(item => item[1] === 'UTC'), true);
});

test('a timezone change between service restarts stops the sequence and retains progress', async t => {
  const calls = [];
  const f = fixture(t, { dependencies: { restartService: async name => { calls.push(name); fs.writeFileSync(f.envFile, 'TZ=Europe/London\n'); } } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true });
  assert.equal(result.error, 'timezone_changed'); assert.equal(result.status, 409);
  assert.deepEqual(result.restarted, ['scheduler']); assert.deepEqual(calls, ['scheduler']);
});
