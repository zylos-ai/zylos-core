import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {createRequire} from 'node:module';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');


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
