import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'dotenv';
import { createInstanceTimezone, replaceTimezoneValue } from '../src/lib/instance-timezone.js';
import { withConfigLock } from '../src/lib/config-mutation.js';

const ALL_SERVICES = ['scheduler', 'web-console', 'zylos-openmax'];

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

test('invalid timezone and unknown fields cannot change the environment', async t => {
  const f = fixture(t), original = fs.readFileSync(f.envFile, 'utf8');
  for (const body of [{ tz: 'Not/AZone' }, { tz: 'asia/tokyo' }, { tz: '+08:00' }, { tz: '-05:30' }, { tz: 'Japan' }, { tz: '' }, { tz: ' UTC' }, { tz: 'UTC', command: 'bad' }, null]) {
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
    assert.equal((await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES })).error, reason);
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
  for (const body of [{ tz: 'UTC' }, { tz: 'UTC', confirm: false }, { tz: 'UTC', confirm: true },
    { tz: 'UTC', confirm: true, names: ['runtime'] }, { tz: 'UTC', confirm: true, services: ['runtime'] },
    { tz: 'UTC', confirm: true, services: [] }, { tz: 'UTC', confirm: true, services: ['scheduler', 'scheduler'] }]) {
    assert.equal((await f.timezone.restart(body)).error, 'confirmation_required');
  }
  assert.equal((await f.timezone.restart({ tz: 'Europe/London', confirm: true, services: ALL_SERVICES })).error, 'timezone_changed');
  assert.equal(f.restarted.length, 0);
});

test('fresh asynchronous discovery is required and errors never reuse an old list', async t => {
  let available = true, calls = 0;
  const f = fixture(t, { dependencies: { readPm2: async () => { calls++; if (!available) throw Error('offline'); return { processes: f.processes }; } } });
  assert.equal((await f.timezone.get()).restart_status, 'known'); available = false;
  assert.equal((await f.timezone.get()).restart_status, 'unknown');
  assert.equal((await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES })).status, 503);
  assert.equal(f.restarted.length, 0); assert.equal(calls, 3);
});

test('confirmed restart uses only current owned candidates and preserves partial failures', async t => {
  const calls = [];
  const f = fixture(t, { dependencies: { restartService: async (name, tz) => { calls.push([name, tz]); if (name === 'web-console') throw Error('private output'); } } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES });
  assert.equal(result.ok, false); assert.equal(result.status, 200);
  assert.deepEqual(result.restarted, ['scheduler', 'zylos-openmax']);
  assert.deepEqual(result.failed, [{ name: 'web-console', error: 'restart_failed' }]);
  assert.deepEqual(result.restart_services, [{ name: 'web-console', status: 'online' }]);
  assert.equal(calls.length, 3); assert.equal(calls.every(item => item[1] === 'UTC'), true);
});

test('a timezone change between service restarts stops the sequence and retains progress', async t => {
  const calls = [];
  const f = fixture(t, { dependencies: { restartService: async name => { calls.push(name); fs.writeFileSync(f.envFile, 'TZ=Europe/London\n'); } } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES });
  assert.equal(result.error, 'timezone_changed'); assert.equal(result.status, 409);
  assert.deepEqual(result.restarted, ['scheduler']); assert.deepEqual(calls, ['scheduler']);
  assert.deepEqual(result.restart_services.map(service => service.name), ['web-console', 'zylos-openmax']);
});

test('unchanged timezone save repairs private permissions without changing bytes', async t => {
  const f = fixture(t, { text: '# exact\r\nTZ="UTC"  # zone\r\nOTHER=keep\r\n' });
  fs.chmodSync(f.envFile, 0o644);
  const before = fs.readFileSync(f.envFile);
  const result = await f.timezone.save({ tz: 'UTC' });
  assert.equal(result.changed, false);
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.envFile).equals(before), true);
  assert.equal(f.logs.length, 0);
  assert.equal(f.restarted.length, 0);
});

test('timezone save waits for the shared environment lock and rereads after acquisition', async t => {
  const f = fixture(t);
  let release, entered;
  const acquired = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const holding = withConfigLock(f.envFile, async () => { entered(); await blocked; });
  await acquired;
  let settled = false;
  const saving = f.timezone.save({ tz: 'Asia/Tokyo' }).finally(() => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(settled, false);
    assert.equal(parse(fs.readFileSync(f.envFile)).TZ, 'UTC');
    fs.writeFileSync(f.envFile, 'TZ=UTC\nOTHER=changed-under-lock\n');
  } finally { release(); await holding; }
  await saving;
  assert.equal(fs.readFileSync(f.envFile, 'utf8'), 'TZ=Asia/Tokyo\nOTHER=changed-under-lock\n');
});

test('concurrent timezone saves preserve the other environment assignments', async t => {
  const f = fixture(t, { text: 'TZ=UTC\nOTHER="keep # literal" # comment\n' });
  await Promise.all(Array.from({ length: 20 }, (_, index) => f.timezone.save({ tz: index % 2 ? 'Asia/Tokyo' : 'Europe/London' })));
  const text = fs.readFileSync(f.envFile, 'utf8');
  assert.equal(text.split('\n').filter(line => line.startsWith('TZ=')).length, 1);
  assert.equal(text.includes('OTHER="keep # literal" # comment\n'), true);
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600);
});

test('confirmation restricts restarts to the displayed names even when new candidates appear', async t => {
  const f = fixture(t);
  f.processes[0].pm2_env.status = 'stopped';
  const displayed = (await f.timezone.get()).restart_services.map(service => service.name);
  f.processes[0].pm2_env.status = 'online';
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true, services: displayed });
  assert.deepEqual(result.restarted, ['web-console', 'zylos-openmax']);
  assert.equal(f.restarted.some(([name]) => name === 'scheduler'), false);
});

test('a partial restart retry does not repeat successfully restarted services', async t => {
  const calls = []; let failWebConsole = true;
  const f = fixture(t, { dependencies: { restartService: async name => {
    calls.push(name); if (name === 'web-console' && failWebConsole) throw Error('unavailable');
  } } });
  const first = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES });
  assert.deepEqual(first.restarted, ['scheduler', 'zylos-openmax']);
  failWebConsole = false;
  const retry = await f.timezone.restart({ tz: 'UTC', confirm: true, services: first.restart_services.map(service => service.name) });
  assert.deepEqual(retry.restarted, ['web-console']);
  assert.deepEqual(calls, ['scheduler', 'web-console', 'zylos-openmax', 'web-console']);
});

test('restart rediscovers ownership before every service and skips vanished candidates', async t => {
  let reads = 0;
  const f = fixture(t, { dependencies: {
    readPm2: async () => { reads++; return { processes: f.processes }; },
    restartService: async name => {
      f.restarted.push([name]);
      if (name === 'scheduler') f.processes[1].pm2_env.ZYLOS_DIR = path.dirname(f.root);
    },
  } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES });
  assert.deepEqual(result.restarted, ['scheduler', 'zylos-openmax']);
  assert.equal(reads, 4);
});

test('discovery failure after progress returns only the unfinished confirmed services', async t => {
  let reads = 0;
  const f = fixture(t, { dependencies: { readPm2: async () => {
    if (++reads >= 3) throw Error('offline');
    return { processes: f.processes };
  } } });
  const result = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ALL_SERVICES });
  assert.equal(result.error, 'service_discovery_unavailable');
  assert.deepEqual(result.restarted, ['scheduler']);
  assert.deepEqual(result.restart_services.map(service => service.name), ['web-console', 'zylos-openmax']);
  assert.equal(result.restart_status, 'unknown');
});

test('initial discovery failure preserves confirmed services for a recovered retry', async t => {
  let available = false;
  const f = fixture(t, { dependencies: { readPm2: async () => {
    if (!available) throw Error('offline');
    return { processes: f.processes };
  } } });
  const failed = await f.timezone.restart({ tz: 'UTC', confirm: true, services: ['web-console'] });
  assert.equal(failed.error, 'service_discovery_unavailable');
  assert.equal(failed.restart_status, 'unknown');
  assert.deepEqual(failed.restart_services.map(service => service.name), ['web-console']);
  assert.equal(f.restarted.length, 0);
  available = true;
  const retry = await f.timezone.restart({ tz: 'UTC', confirm: true, services: failed.restart_services.map(service => service.name) });
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.restarted, ['web-console']);
  assert.deepEqual(f.restarted.map(([name]) => name), ['web-console']);
});

test('managed restart awaits the asynchronous existing helper execution and reports rejection', async t => {
  const calls = []; let release, startedExecution;
  const completion = new Promise((resolve, reject) => { release = reject; });
  const started = new Promise(resolve => { startedExecution = resolve; });
  const f = fixture(t, { dependencies: { restartService: undefined, execute: (command, options) => {
    calls.push({ command, options }); startedExecution(); return completion;
  } } });
  let settled = false;
  const request = f.timezone.restart({ tz: 'UTC', confirm: true, services: ['scheduler'] }).finally(() => { settled = true; });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls[0].command, 'pm2 restart "scheduler" --update-env 2>/dev/null');
  assert.equal(calls[0].options.env.ZYLOS_DIR, f.root);
  assert.equal(calls[0].options.env.TZ, 'UTC');
  assert.equal(calls[0].options.timeout, 15_000);
  release(Error('private process output'));
  const result = await request;
  assert.deepEqual(result.failed, [{ name: 'scheduler', error: 'restart_failed' }]);
  assert.deepEqual(result.restarted, []);
});
