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

test('runner cleans real PM2 daemons from allocated and nested homes', { skip: !hasPm2 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pm2-cleanup-'));
  try {
    for (const directory of ['home/.pm2', 'nested/pm2']) {
      const home = path.join(root, directory);
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

test('runner cleans an owned daemon after its PM2 home was deleted', { skip: !hasPm2 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pm2-deleted-'));
  const home = path.join(root, 'pm2');
  try {
    execFileSync('pm2', ['ping'], { env: { ...process.env, PM2_HOME: home }, stdio: 'pipe', timeout: 10000 });
    fs.rmSync(home, { recursive: true, force: true });
    cleanupTestPm2(root);
    assert(!listPm2Daemons().some(daemon => daemon.home === home));
  } finally {
    cleanupTestPm2(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
