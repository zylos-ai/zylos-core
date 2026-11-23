import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
