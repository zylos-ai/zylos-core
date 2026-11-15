import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cleanupTestPm2, listPm2Daemons } from '../../../scripts/test-pm2-cleanup.js';

const hasPm2 = (process.env.PATH || '').split(path.delimiter).some(directory => {
  try { fs.accessSync(path.join(directory, 'pm2'), fs.constants.X_OK); return true; }
  catch { return false; }
});

// Integration boundary: a real PM2 daemon with HOME/ZYLOS_DIR inherited from the
// isolated runner and PM2_HOME replaced before ping. Run for runner isolation or
// cleanup changes; skip only when PM2 is unavailable or the change is unrelated.
// createTestEnvironment cleanup/exit removes the owned daemon and directory.
test('runner environment isolates inherited PM2_HOME and cleans on explicit cleanup and exit', { skip: !hasPm2 }, () => {
  const module = new URL('../../../scripts/test-environment.js', import.meta.url).href;
  for (const explicit of [true, false]) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { createTestEnvironment } from ${JSON.stringify(module)};
      const previous = process.env.PM2_HOME;
      const environment = createTestEnvironment();
      assert.equal(process.env.PM2_HOME, path.join(environment.root, 'home/.pm2'));
      assert(Buffer.byteLength(path.join(process.env.PM2_HOME, 'rpc.sock')) < 104);
      execFileSync('pm2', ['ping'], { stdio: 'pipe', timeout: 10000 });
      console.log(environment.root);
      if (${explicit}) {
        environment.cleanup();
        assert.equal(process.env.PM2_HOME, previous);
      }
    `], { encoding: 'utf8', env: { ...process.env, PM2_HOME: '/unused-inherited-pm2' }, timeout: 20000 });
    const root = output.trim();
    assert(!fs.existsSync(root));
    assert(!listPm2Daemons().some(daemon => daemon.home.startsWith(`${root}/`)));
  }
});

// Integration boundary: real PM2 homes nested under the runner's short TMPDIR.
// Run for temporary-root or PM2 cleanup changes; skip when PM2 is unavailable or
// the change is unrelated. finally stops only these homes and removes the root.
test('runner cleans real PM2 daemons from allocated and nested homes', { skip: !hasPm2 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pm2-cleanup-'));
  try {
    for (const directory of ['home/.pm2', 'nested/pm2']) {
      const home = path.join(root, directory);
      assert(Buffer.byteLength(path.join(home, 'rpc.sock')) < 104);
      execFileSync('pm2', ['ping'], { env: { ...process.env, PM2_HOME: home }, stdio: 'pipe', timeout: 10000 });
      assert(listPm2Daemons().some(daemon => daemon.home === home));
    }
    cleanupTestPm2(root);
    assert(!listPm2Daemons().some(daemon => daemon.home.startsWith(`${root}/`)));
  } finally {
    cleanupTestPm2(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exit guard rejects a surviving daemon and never stops a sibling home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pm2-guard-'));
  const owned = { pid: 123, home: path.join(root, 'home/.pm2') };
  const outside = { pid: 456, home: `${root}-sibling/home/.pm2` };
  const stopped = [];
  try {
    assert.throws(() => cleanupTestPm2(root, {
      list: () => [owned, outside], stop: (_root, home) => stopped.push(home), attempts: 0,
    }), /Test runner leaked PM2 daemons: 123/);
    assert.deepEqual(stopped, [owned.home]);
    cleanupTestPm2(root, { list: () => [outside], stop: () => assert.fail('outside daemon was stopped') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Integration boundary: a real PM2 daemon whose private home is removed. Run
// for cleanup/root changes; skip when PM2 is unavailable or unrelated. finally
// uses the allocated root to stop the owned daemon and remove remaining files.
test('runner cleans an owned daemon after its PM2 home was deleted', { skip: !hasPm2 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pm2-deleted-'));
  const home = path.join(root, 'pm2');
  try {
    assert(Buffer.byteLength(path.join(home, 'rpc.sock')) < 104);
    execFileSync('pm2', ['ping'], { env: { ...process.env, PM2_HOME: home }, stdio: 'pipe', timeout: 10000 });
    fs.rmSync(home, { recursive: true, force: true });
    cleanupTestPm2(root);
    assert(!listPm2Daemons().some(daemon => daemon.home === home));
  } finally {
    cleanupTestPm2(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('daemon enumeration resolves truncated titles from same-user Linux environments', () => {
  const exec = () => '100 123 PM2 v7.0.1: God Daemon (/tmp/cut\n101 456 PM2 v7.0.1: God Daemon (/other';
  const home = '/tmp/complete/home/.pm2';
  const readFile = (file, encoding) => {
    assert.equal(file, '/proc/123/environ');
    assert.equal(encoding, 'utf8');
    return `OTHER=value\0PM2_HOME=${home}\0`;
  };
  assert.deepEqual(listPm2Daemons({ exec, readFile, platform: 'linux', uid: 100 }), [{ pid: 123, home }]);
});

test('daemon enumeration rejects unverifiable candidates and tolerates exited processes', () => {
  const exec = () => '100 123 PM2 v7.0.1: God Daemon (/tmp/cut';
  const options = { exec, platform: 'linux', uid: 100 };
  for (const code of ['EACCES', 'EPERM']) {
    assert.throws(() => cleanupTestPm2('/tmp/test-root', {
      list: () => listPm2Daemons({ ...options, readFile: () => { throw Object.assign(new Error(), { code }); } }),
      stop: () => assert.fail('unverified daemon was stopped'),
    }), /Cannot verify PM2 daemon 123: environment unreadable/);
  }
  for (const environment of ['', 'PM2_HOME=relative\0']) {
    assert.throws(() => listPm2Daemons({ ...options, readFile: () => environment }), /Cannot verify PM2 daemon/);
  }
  for (const code of ['ENOENT', 'ESRCH']) {
    assert.deepEqual(listPm2Daemons({ ...options, readFile: () => { throw Object.assign(new Error(), { code }); } }), []);
  }
  assert.throws(() => listPm2Daemons({ ...options, platform: 'darwin' }), /unavailable or truncated/);
  assert.deepEqual(listPm2Daemons({ ...options, platform: 'darwin',
    exec: () => '100 123 PM2 v7.0.1: God Daemon (/tmp/full)',
  }), [{ pid: 123, home: '/tmp/full' }]);
});

// Integration boundary: only a fixture process and a home beneath the isolated
// runner TMPDIR. finally terminates this child and removes its private root.
test('runner finds and cleans a live daemon with a truncated title and deleted home', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-cut-'));
  const home = path.join(root, 'home/.pm2');
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [new URL('./fixtures/truncated-pm2-daemon.js', import.meta.url).pathname], {
    env: { ...process.env, PM2_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const title = execFileSync('ps', ['-p', String(child.pid), '-o', 'args='], { encoding: 'utf8' }).trim();
    assert.match(title, /^PM2 .*: God Daemon \(/);
    assert(!title.endsWith(')'), title);
    assert(listPm2Daemons().some(daemon => daemon.pid === child.pid && daemon.home === home));
    fs.rmSync(home, { recursive: true });
    assert.throws(() => cleanupTestPm2(root, { stop: () => {}, attempts: 0 }), /Test runner leaked PM2 daemons/);
    cleanupTestPm2(root);
    await exited;
    assert(!listPm2Daemons().some(daemon => daemon.pid === child.pid));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
