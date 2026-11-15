import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LOG_ROTATE_DEFAULTS, ensurePm2LogRotate, logRotateInstallCommand, isLogRotateInstalled, resolvePm2Home,
} from '../pm2-logrotate.js';
import { fakePm2, processAlive } from './helpers/fake-pm2-logrotate.js';

// Every PM2 call goes to a fake `pm2` first on a PATH without the real one, under
// a private PM2_HOME inside the test temp directory. No network, no live PM2.

const DEFAULT_CALLS = [
  ['set', 'pm2-logrotate:max_size', '10M'],
  ['set', 'pm2-logrotate:retain', '7'],
  ['set', 'pm2-logrotate:compress', 'true'],
  ['set', 'pm2-logrotate:workerInterval', '30'],
  ['set', 'pm2-logrotate:rotateInterval', '0 0 * * *'],
  ['install', 'pm2-logrotate'],
];
const COMPONENT_LIFECYCLE = new Set(['start', 'restart', 'reload', 'stop', 'delete', 'kill', 'startOrRestart', 'startOrReload', 'save', 'resurrect']);

function assertOnlyLogRotateCalls(calls) {
  for (const args of calls) {
    assert.equal(COMPONENT_LIFECYCLE.has(args[0]), false, `component lifecycle command: ${args.join(' ')}`);
    assert.match(args[1], /^pm2-logrotate(:|$)/, `call targets another process: ${args.join(' ')}`);
  }
}

test('missing module is configured with the defaults and installed', async t => {
  const f = fakePm2(t);
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.deepEqual(result, { state: 'installed' });
  assert.deepEqual(f.calls(), DEFAULT_CALLS);
  assertOnlyLogRotateCalls(f.calls());
  const conf = f.conf();
  for (const [key, value] of LOG_ROTATE_DEFAULTS) assert.equal(conf['pm2-logrotate'][key], value, key);
  assert.equal(isLogRotateInstalled(f.pm2Home), true);
});

test('existing module keeps every custom value and receives no PM2 command', async t => {
  const f = fakePm2(t);
  f.writeConf({
    'module-db-v2': { 'pm2-logrotate': {} },
    'pm2-logrotate': { max_size: '50M', retain: '3', compress: false, workerInterval: '120', rotateInterval: '0 3 * * 1', TZ: 'Asia/Singapore' },
  });
  const before = fs.readFileSync(f.confFile);
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.deepEqual(result, { state: 'present' });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(fs.readFileSync(f.confFile), before);
});

test('a module installed from a tarball also counts as present', async t => {
  const f = fakePm2(t);
  f.writeConf({ 'tar-modules': { 'pm2-logrotate': { installed_at: 1 } } });
  assert.deepEqual(await ensurePm2LogRotate({ env: f.env }), { state: 'present' });
  assert.deepEqual(f.calls(), []);
});

test('install failure returns one warning with the reason and the install command', async t => {
  const f = fakePm2(t, { mode: 'fail' });
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.equal(result.state, 'failed');
  assert.equal(result.warning.includes('\n'), false);
  assert.match(result.warning, /pm2 install exited with 1: npm error code ENOTFOUND.*npm error network request failed.*Installation failed via NPM/);
  assert.match(result.warning, /will not be rotated automatically/);
  assert.ok(result.warning.endsWith(`Install it later with: ${logRotateInstallCommand()}`));
  assert.deepEqual(f.calls(), DEFAULT_CALLS);
  assertOnlyLogRotateCalls(f.calls());
});

test('install timeout stops pm2 and the npm process it started within the deadline', async t => {
  const f = fakePm2(t, { mode: 'timeout' });
  const started = Date.now();
  const result = await ensurePm2LogRotate({ env: f.env, timeouts: { set: 10_000, install: 1_500 } });
  const elapsed = Date.now() - started;
  assert.equal(result.state, 'failed');
  assert.match(result.warning, /pm2 install did not finish within 2 s/);
  assert.match(result.warning, /Install it later with: /);
  assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
  const child = f.childPid();
  const deadline = Date.now() + 5_000;
  while (processAlive(child) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(processAlive(child), false, 'npm-like child of pm2 install is stopped');
  assert.equal(isLogRotateInstalled(f.pm2Home), false);
});

test('a set timeout also fails without installing', async t => {
  const f = fakePm2(t);
  fs.writeFileSync(`${f.bin}/pm2`, `#!/bin/sh\necho "$*" >> "${f.root}/calls.txt"\nexec sleep 600\n`);
  const result = await ensurePm2LogRotate({ env: f.env, timeouts: { set: 500, install: 10_000 } });
  assert.equal(result.state, 'failed');
  assert.match(result.warning, /pm2 set did not finish within 1 s/);
  assert.deepEqual(fs.readFileSync(`${f.root}/calls.txt`, 'utf8').trim().split('\n'), ['set pm2-logrotate:max_size 10M']);
});

test('missing pm2 command becomes a warning', async t => {
  const f = fakePm2(t, { installPm2: false });
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.equal(result.state, 'failed');
  assert.match(result.warning, /pm2 set could not run: .*ENOENT/);
});

test('successful install without a PM2 module record is reported as not installed', async t => {
  const f = fakePm2(t, { mode: 'no-record' });
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.equal(result.state, 'failed');
  assert.match(result.warning, /pm2 install finished but PM2 has no pm2-logrotate module record/);
});

test('unreadable PM2 module records leave PM2 untouched', async t => {
  const f = fakePm2(t);
  f.writeConf('{"module-db-v2": {');
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.equal(result.state, 'failed');
  assert.match(result.warning, /Could not read PM2 module records in .*module_conf\.json/);
  assert.match(result.warning, /was not installed or changed/);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.readFileSync(f.confFile, 'utf8'), '{"module-db-v2": {');
});

test('the printed install command runs as written in a POSIX shell', async t => {
  const f = fakePm2(t, { mode: 'fail' });
  f.enablePackageManager();
  const failed = await ensurePm2LogRotate({ env: f.env });
  assert.equal(failed.state, 'failed');
  const command = failed.warning.split('Install it later with: ')[1];
  f.env.FAKE_PM2_MODE = 'success';
  fs.writeFileSync(`${f.root}/calls.jsonl`, '');
  const shell = spawnSync('/bin/sh', ['-c', command], { env: f.env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(f.calls(), DEFAULT_CALLS);
  assert.equal(isLogRotateInstalled(f.pm2Home), true);
});

test('PM2_HOME follows the PM2 default', () => {
  assert.equal(resolvePm2Home({ PM2_HOME: '/custom/pm2' }), '/custom/pm2');
  assert.equal(resolvePm2Home({ HOME: '/home/someone' }), '/home/someone/.pm2');
});


test('install selects npm when failing bun shares the PM2 and Node directory', async t => {
  const f = fakePm2(t);
  f.enablePackageManager();
  const originalPath = f.env.PATH;
  assert.equal((await ensurePm2LogRotate({ env: f.env })).state, 'installed');
  assert.equal(f.env.PATH, originalPath);
  assert.deepEqual(f.calls(), DEFAULT_CALLS);
  const installedPath = fs.readFileSync(`${f.root}/install-path.txt`, 'utf8');
  const mirror = installedPath.split(':')[0];
  assert.ok(mirror.startsWith(`${f.pm2Home}/modules/pm2-logrotate/.zylos-npm-path/`));
  assert.equal(fs.existsSync(`${mirror}/bun`), false);
  for (const tool of ['node', 'npm', 'pm2']) fs.accessSync(`${mirror}/${tool}`, fs.constants.X_OK);
  const later = spawnSync('npm', ['--version'], { env: { ...f.env, PATH: installedPath }, encoding: 'utf8', timeout: 5_000 });
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.stdout, /npm selected/);
});

test('warning keeps real stdout and stderr errors before generic PM2 failure', async t => {
  const f = fakePm2(t);
  f.enablePackageManager();
  fs.writeFileSync(`${f.bin}/npm`, '#!/bin/sh\necho "npm error stdout cause"\necho "npm error stderr cause" >&2\nexit 1\n');
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.equal(result.state, 'failed');
  assert.match(result.warning, /npm error stdout cause/);
  assert.match(result.warning, /npm error stderr cause/);
  assert.ok(result.warning.endsWith(logRotateInstallCommand()));
});

test('failure details remain bounded when npm prints many error lines', async t => {
  const f = fakePm2(t);
  const result = await ensurePm2LogRotate({ env: f.env, run: async () => ({
    ok: false, code: 1, stderr: 'npm error real cause\n' + 'npm error '.repeat(1000) + '\n'.repeat(1000),
  }) });
  assert.match(result.warning, /npm error real cause/);
  assert.ok(result.warning.length < 3000);
  assert.equal(result.warning.includes('\n'), false);
});


test('npm PATH remains absolute when PM2_HOME is relative and the module changes directory', async t => {
  const f = fakePm2(t);
  f.enablePackageManager();
  f.env.PM2_HOME = path.relative(process.cwd(), f.pm2Home);
  assert.equal((await ensurePm2LogRotate({ env: f.env })).state, 'installed');
  const installedPath = fs.readFileSync(`${f.root}/install-path.txt`, 'utf8');
  assert.equal(path.isAbsolute(installedPath.split(path.delimiter)[0]), true);
  const later = spawnSync('npm', [], { env: { ...f.env, PATH: installedPath }, cwd: f.root,
    encoding: 'utf8', timeout: 5_000 });
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.stdout, /npm selected/);
});
