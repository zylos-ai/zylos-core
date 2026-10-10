import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');
function fixture(t, {ecosystem=false}={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-service-start-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const skillsDir = path.join(root, '.claude/skills');
  const script = path.join(skillsDir, 'scheduler/scripts/scheduler.js');
  fs.mkdirSync(path.dirname(script), {recursive:true});
  fs.writeFileSync(script, '// saved service');
  const file = path.join(root, 'pm2/ecosystem.config.cjs');
  if (ecosystem) {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'module.exports={apps:[]};', {mode:0o600});
  }
  const j = {zylosDir:root, skillsDir, phase:'restored_verifying', originalServices:[{name:'scheduler', script}], initialIdentity:{ecosystemHash:ecosystem?m.hash(file):null}};
  let records = [{name:'scheduler', pid:0, pm2_env:{status:'stopped', pm_exec_path:script}}];
  const commands = [];
  const spawn = cp.spawnSync;
  cp.spawnSync = (bin, args) => {
    commands.push([bin, ...args]);
    return {status:0, stdout:args[0]==='jlist'?JSON.stringify(records):'', stderr:''};
  };
  t.after(() => {cp.spawnSync = spawn;});
  return {root, file, j, commands, records:next => {records=next;}};
}
test('originally missing ecosystem restarts verified saved PM2 names without invoking journal script paths', t => {
  const f = fixture(t);
  m.start(f.j);
  assert.deepEqual(f.commands, [['pm2','jlist'], ['pm2','restart','scheduler','--update-env'], ['pm2','save']]);
  assert.equal(fs.existsSync(f.file), false);
});
for (const changed of ['missing', 'outside', 'changed', 'journal-script']) test(`missing ecosystem restart refuses ${changed} PM2 provenance before starting any service`, t => {
  const f = fixture(t);
  if (changed==='missing') f.records([]);
  if (changed==='outside') f.records([{name:'scheduler', pm2_env:{pm_exec_path:'/tmp/untrusted.js'}}]);
  if (changed==='changed') f.records([{name:'scheduler', pm2_env:{pm_exec_path:path.join(f.j.skillsDir, 'scheduler/scripts/changed.js')}}]);
  if (changed==='journal-script') f.j.originalServices[0].script='/tmp/untrusted.js';
  assert.throws(() => m.start(f.j), /original PM2 service record missing or changed/);
  assert.deepEqual(f.commands, [['pm2','jlist']]);
});
for (const defect of ['missing', 'changed', 'symlink']) test(`originally present ecosystem ${defect} fails closed for restored service restart`, t => {
  const f = fixture(t, {ecosystem:true});
  if (defect==='changed') fs.appendFileSync(f.file, '// altered');
  else {
    fs.unlinkSync(f.file);
    if (defect==='symlink') fs.symlinkSync(path.join(f.root,'outside'),f.file);
  }
  assert.throws(() => m.start(f.j), /ENOENT|identity changed|unsafe recovery path/);
  assert.deepEqual(f.commands, []);
});
test('present verified original ecosystem retains startOrRestart behavior', t => {
  const f = fixture(t, {ecosystem:true});
  m.start(f.j);
  assert.deepEqual(f.commands, [['pm2','startOrRestart',f.file,'--only','scheduler','--update-env'], ['pm2','save']]);
});
test('new-code ready verification allows intentional regenerated ecosystem bytes', t => {
  const f = fixture(t, {ecosystem:true});
  f.j.phase='new_verifying';
  fs.appendFileSync(f.file, '// legitimate updated ecosystem');
  assert.doesNotThrow(() => m.start(f.j));
  assert.equal(f.commands[0][1], 'startOrRestart');
});
