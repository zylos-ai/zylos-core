import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeSessionLaunchScript } from '../session-command.js';
import { injectLaunchCleanupRace } from './helpers/launch-cleanup-race.js';

function fixture(t) {
  const script = writeSessionLaunchScript({command:'/bin/true', args:[], env:{}, root:os.tmpdir(), multi:false});
  t.after(() => { t.mock.restoreAll(); script.cleanup(); });
  return script;
}

for (const operation of ['readdirSync', 'unlinkSync', 'rmdirSync']) {
  test(`launch cleanup tolerates concurrent deletion during ${operation}`, t => {
    const script = fixture(t);
    const verify = injectLaunchCleanupRace(t, script, operation);
    script.cleanup();
    verify();
    script.cleanup();
  });
}

test('launch cleanup tolerates a directory already removed by the shell', t => {
  const script = fixture(t);
  fs.unlinkSync(script.file);
  fs.rmdirSync(path.dirname(script.file));
  script.cleanup();
});

for (const code of ['EACCES', 'OWNED_TREE_PATH_INVALID']) {
  test(`launch cleanup preserves ${code}`, t => {
    const script = fixture(t);
    const failure = Object.assign(new Error('fixture cleanup failure'), {code});
    const original = fs.readdirSync;
    const method = t.mock.method(fs, 'readdirSync', function(file, ...args) {
      if (file === path.dirname(script.file)) throw failure;
      return original.call(this, file, ...args);
    });
    assert.throws(() => script.cleanup(), error => error === failure);
    method.mock.restore();
    script.cleanup();
  });
}

test('launch cleanup tolerates the shell rmdir racing the single retry', t => {
  const script = fixture(t);
  const dir = path.dirname(script.file);
  const unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
  let unlinks = 0, rmdirs = 0;
  t.mock.method(fs, 'unlinkSync', function(file, ...args) {
    if (file === script.file) { unlinks++; unlink(file); }
    return unlink.call(this, file, ...args);
  });
  t.mock.method(fs, 'rmdirSync', function(file, ...args) {
    if (file === dir) { rmdirs++; rmdir(file); }
    return rmdir.call(this, file, ...args);
  });
  script.cleanup();
  assert.equal(unlinks, 1);
  assert.equal(rmdirs, 1, 'retry reaches rmdir and accepts its ENOENT');
  assert.equal(fs.existsSync(dir), false);
});

test('launch cleanup propagates a non-missing error from the retry', t => {
  const script = fixture(t);
  const dir = path.dirname(script.file);
  const unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
  const failure = Object.assign(new Error('fixture retry failure'), {code:'EACCES'});
  t.mock.method(fs, 'unlinkSync', function(file, ...args) {
    if (file === script.file) unlink(file);
    return unlink.call(this, file, ...args);
  });
  t.mock.method(fs, 'rmdirSync', function(file, ...args) {
    if (file === dir) throw failure;
    return rmdir.call(this, file, ...args);
  });
  assert.throws(() => script.cleanup(), error => error === failure);
});
