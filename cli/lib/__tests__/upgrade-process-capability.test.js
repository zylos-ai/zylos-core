import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

test('Linux without reliable proc identity retains exclusive live ownership and rejects interrupted takeover', {skip:process.platform !== 'linux'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-live-capability-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (String(file).startsWith('/proc/')) throw Object.assign(Error('restricted fixture'), {code:'EACCES'});
    return read(file, ...args);
  };
  try {
    assert.equal(m.platformSupported(), true);
    assert.equal(m.canRecognizeProcesses(), false);
    const release = m.acquire(dir);
    assert.equal(m.read(path.join(dir, 'controller.json')).mode, 'live-owner');
    assert.equal(release.withOwnership(dir, () => 'owned'), 'owned');
    assert.throws(() => m.acquire(dir), /admission retained/);
    assert.throws(() => m.stopObserved({}), /process view incomplete/);
    release();
  } finally { fs.readFileSync = read; }
});

test('Linux without trusted flock selects the live ownership route', {skip:process.platform !== 'linux'}, () => {
  const realpath = fs.realpathSync;
  fs.realpathSync = (file, ...args) => {
    if (['/usr/bin/flock','/bin/flock'].includes(file)) throw Object.assign(Error('missing fixture'), {code:'ENOENT'});
    return realpath(file, ...args);
  };
  try { assert.equal(m.canRecognizeProcesses(), false); assert.equal(m.platformSupported(), true); }
  finally { fs.realpathSync = realpath; }
});
