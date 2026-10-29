import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import {createRequire} from 'node:module';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function processView(t, {ppid = 0, parentReadable = true, hidepid = false, unreadableWriter = false} = {}) {
  const read = fs.readFileSync, readdir = fs.readdirSync, realpath = fs.realpathSync, stat = fs.statSync;
  const parent = Object.getOwnPropertyDescriptor(process, 'ppid');
  Object.defineProperty(process, 'ppid', {configurable:true,enumerable:true,get:()=>ppid});
  fs.readFileSync = (file, ...args) => {
    const name = String(file);
    if (name === '/proc/mounts') return `proc /proc proc rw,hidepid=${hidepid ? '2' : '0'} 0 0\n`;
    if (name === '/proc/sys/kernel/random/boot_id') return 'fixture-boot\n';
    if (name.startsWith('/proc/')) {
      if (name.startsWith('/proc/0/')) assert.fail('namespace parent PID 0 must never be queried');
      if ((!parentReadable && name.startsWith(`/proc/${ppid}/`)) || (unreadableWriter && name.startsWith('/proc/999999/'))) {
        throw Object.assign(Error('restricted fixture'), {code:'EACCES'});
      }
      return name.endsWith('/stat') ? `${process.pid} (node) S ${Array(18).fill('0').join(' ')} 123` : 'node\0fixture\0';
    }
    return read(file, ...args);
  };
  fs.readdirSync = (file, ...args) => file === '/proc' ? [String(process.pid), ...(unreadableWriter ? ['999999'] : [])] : readdir(file, ...args);
  fs.realpathSync = (file, ...args) => ['/usr/bin/flock', '/bin/flock'].includes(file) ? '/fixture/flock' : realpath(file, ...args);
  fs.statSync = (file, ...args) => file === '/fixture/flock' ? {isFile:()=>true,mode:0o755} : stat(file, ...args);
  t.after(() => {
    Object.defineProperty(process, 'ppid', parent);
    fs.readFileSync = read; fs.readdirSync = readdir; fs.realpathSync = realpath; fs.statSync = stat;
  });
  return m;
}

test('Linux PID namespace root recognizes a complete process view without a visible parent', {skip:process.platform !== 'linux'}, t => {
  const isolated = processView(t);
  assert.equal(isolated.canRecognizeProcesses(), true);
});

for (const [name, options] of [
  ['nonzero parent cannot be identified', {ppid:999998,parentReadable:false}],
  ['namespace root with hidepid restriction', {hidepid:true}],
  ['namespace root with an unreadable writer', {unreadableWriter:true}],
]) test(`Linux rejects automatic process recognition: ${name}`, {skip:process.platform !== 'linux'}, t => {
  const isolated = processView(t, options);
  assert.equal(isolated.canRecognizeProcesses(), false);
});

test('Linux without reliable proc identity retains exclusive live ownership and rejects interrupted takeover', {skip:process.platform !== 'linux'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-live-capability-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (String(file).startsWith('/proc/')) throw Object.assign(Error('restricted fixture'), {code:'EACCES'});
    return read(file, ...args);
  };
  try {

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
  try { assert.equal(m.canRecognizeProcesses(), false); }
  finally { fs.realpathSync = realpath; }
});

test('restricted Linux stop refuses an incomplete writer view before any PM2 command', {skip:process.platform !== 'linux'}, t => {
  const calls = [], read = fs.readFileSync, spawn = cp.spawnSync;
  fs.readFileSync = (file, ...args) => {
    if (String(file).startsWith('/proc/')) throw Object.assign(Error('restricted fixture'), {code:'EACCES'});
    return read(file, ...args);
  };
  cp.spawnSync = command => {calls.push(command); return {status:0,stdout:'[]',stderr:''};};
  t.after(() => {fs.readFileSync = read; cp.spawnSync = spawn;});
  assert.throws(() => m.stop({zylosDir:'/isolated',skillsDir:'/isolated/skills'}), /process view incomplete/);
  assert.deepEqual(calls, []);
});
