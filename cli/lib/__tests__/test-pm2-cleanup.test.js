import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cleanupTestPm2, listPm2Daemons } from '../../../scripts/test-pm2-cleanup.js';

// Adapt the synthetic ps rows to the columns requested by the product.
const psRow = (row, args) => args[1].includes('stat=') ? row : row.replace(/ (?:S|Z) /g, ' ');

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
  const exec = () => '100 123 S PM2 v7.0.1: God Daemon (/tmp/cut\n101 456 S PM2 v7.0.1: God Daemon (/other';
  const home = '/tmp/complete/home/.pm2';
  const readFile = (file, encoding) => {
    assert.equal(file, '/proc/123/environ');
    assert.equal(encoding, 'utf8');
    return `OTHER=value\0PM2_HOME=${home}\0`;
  };
  assert.deepEqual(listPm2Daemons({ exec, readFile, platform: 'linux', uid: 100 }), [{ pid: 123, home }]);
});

test('daemon enumeration rejects unverifiable candidates and tolerates exited processes', () => {
  const exec = () => '100 123 S PM2 v7.0.1: God Daemon (/tmp/cut';
  const options = { exec, platform: 'linux', uid: 100 };
  for (const code of ['EACCES', 'EPERM']) {
    assert.throws(() => cleanupTestPm2('/tmp/test-root', {
      list: () => listPm2Daemons({ ...options, readFile: () => { throw Object.assign(new Error(), { code }); } }),
      stop: () => assert.fail('unverified daemon was stopped'),
    }), /Cannot verify PM2 daemon 123: environment unreadable/);
  }
  for (const environment of ['', 'OTHER=value\0', 'PM2_HOME=relative\0']) {
    assert.throws(() => listPm2Daemons({ ...options, readFile: () => environment }), /Cannot verify PM2 daemon/);
  }
  for (const code of ['ENOENT', 'ESRCH']) {
    assert.deepEqual(listPm2Daemons({ ...options, readFile: () => { throw Object.assign(new Error(), { code }); } }), []);
  }
  assert.throws(() => listPm2Daemons({ ...options, platform: 'darwin' }), /unavailable or truncated/);
  assert.deepEqual(listPm2Daemons({ ...options, platform: 'darwin',
    exec: () => '100 123 S PM2 v7.0.1: God Daemon (/tmp/full)',
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


test('daemon enumeration rechecks candidates when environment reads race with exit', () => {
  const live = '100 123 S PM2 v7.0.1: God Daemon (/tmp/cut';
  for (const changed of ['', '100 123 Z PM2 v7.0.1: God Daemon <defunct>',
    '100 123 S unrelated process', '101 123 S PM2 v7.0.1: God Daemon (/tmp/cut']) {
    for (const value of ['EACCES', 'EPERM', 'EIO', '', 'OTHER=value\0']) {
      let snapshots = 0;
      let reads = 0;
      cleanupTestPm2('/tmp/test-root', {
        list: () => listPm2Daemons({
          platform: 'linux', uid: 100,
          exec: (_command, args) => psRow(++snapshots === 1 ? live : changed, args),
          readFile: () => {
            reads++;
            if (value.startsWith('E')) throw Object.assign(new Error('process changed'), { code: value });
            return value;
          },
        }),
        stop: () => assert.fail('unverified process was stopped'),
      });
      assert.equal(reads, 1);
      assert(snapshots >= 2);
    }
  }
});

test('daemon enumeration retries transient reads and still cleans owned homes', () => {
  for (const first of ['EACCES', 'EPERM', 'EIO', '', 'OTHER=value\0', 'PM2_HOME=relative\0']) {
    let reads = 0;
    const home = '/tmp/test-root/pm2';
    const stopped = [];
    let running = true;
    cleanupTestPm2('/tmp/test-root', {
      list: () => running ? listPm2Daemons({
        platform: 'linux', uid: 100,
        exec: (_command, args) => psRow('100 123 S PM2 v7.0.1: God Daemon (/tmp/cut', args),
        readFile: () => {
          if (++reads === 1) {
            if (first.startsWith('E')) throw Object.assign(new Error('transient read'), { code: first });
            return first;
          }
          return `PM2_HOME=${home}\0`;
        },
      }) : [],
      stop: (_root, found) => { stopped.push(found); running = false; },
    });
    assert.equal(reads, 2);
    assert.deepEqual(stopped, [home]);
  }
});

test('daemon enumeration reports the original code for persistent unreadable live candidates', () => {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    let reads = 0;
    const cause = Object.assign(new Error('permission or I/O failure'), { code });
    assert.throws(() => listPm2Daemons({
      platform: 'linux', uid: 100,
      exec: (_command, args) => psRow('100 123 S PM2 v7.0.1: God Daemon (/tmp/cut', args),
      readFile: () => { reads++; throw cause; },
    }), error => {
      assert.equal(error.cause, cause);
      assert.match(error.message, new RegExp(`environment unreadable.*${code}`));
      return true;
    });
    assert.equal(reads, 2);
  }
});


test('daemon enumeration rechecks exit after the final read and excludes dead candidates', () => {
  const live = '100 123 S PM2 v7.0.1: God Daemon (/tmp/cut';
  for (const value of ['EACCES', '', 'OTHER=value\0', 'PM2_HOME=relative\0']) {
    let snapshots = 0;
    let reads = 0;
    assert.deepEqual(listPm2Daemons({
      platform: 'linux', uid: 100,
      exec: () => ++snapshots < 3 ? live : '',
      readFile: () => {
        reads++;
        if (value === 'EACCES') throw Object.assign(new Error('exit race'), { code: value });
        return value;
      },
    }), []);
    assert.equal(reads, 2);
    assert.equal(snapshots, 3);
  }
  for (const state of ['Z', 'Zs', 'X']) {
    assert.deepEqual(listPm2Daemons({
      platform: 'linux', uid: 100,
      exec: () => `100 123 ${state} PM2 v7.0.1: God Daemon (/tmp/cut`,
      readFile: () => assert.fail('dead process environment was read'),
    }), []);
  }
});

// Integration boundary: one fixture child under the isolated runner root. The
// read hook forces exit after ps discovery and before the real environ read;
// blocking until Z keeps the child unreaped without relying on scheduling luck.
test('daemon enumeration tolerates a real process exiting between discovery and environment read', {
  skip: process.platform !== 'linux',
}, async () => {
  const child = spawn(process.execPath, [new URL('./fixtures/truncated-pm2-daemon.js', import.meta.url).pathname], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let observed;
  try {
    await once(child.stdout, 'data');
    const daemons = listPm2Daemons({ readFile: (file, encoding) => {
      if (file !== `/proc/${child.pid}/environ`) return fs.readFileSync(file, encoding);
      child.kill();
      const deadline = Date.now() + 3000;
      while (true) {
        const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) break;
        assert(Date.now() < deadline, 'fixture did not become a zombie');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      try {
        const environment = fs.readFileSync(file, encoding);
        observed = environment === '' ? 'empty' : 'readable';
        return environment;
      } catch (error) { observed = error.code; throw error; }
    } });
    assert(['EACCES', 'EPERM', 'ESRCH', 'ENOENT', 'empty'].includes(observed), observed);
    assert(!daemons.some(daemon => daemon.pid === child.pid));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});
