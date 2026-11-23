import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import cp from 'node:child_process';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';
const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');

for (const entry of ['stop', 'stopObserved']) {
  for (const state of [
    {status:'online',pid:4321},
    {status:'stopped',pid:4321},
    {status:'launching',pid:0},
  ]) test(`${entry} identifies every service that fails stopped verification with status ${state.status}`, t => {
    const f = serviceRestartFixture(t);
    const spawn = cp.spawnSync;
    let lists = 0;
    cp.spawnSync = (file, args, options) => {
      if (file !== 'pm2') return spawn(file, args, options);
      assert.equal(args[0], 'jlist');
      lists++;
      const records = [f.record('scheduler'), f.record('custom-service')];
      if (lists === 2) {
        Object.assign(records[0], {pid:state.pid});
        records[0].pm2_env.status = state.status;
        records[1] = f.record('custom-service', 'online');
        records.push({name:'unrelated',pid:9876,pm2_env:{status:'online',pm_exec_path:path.join(f.root,'outside.js')}});
      }
      return {status:0, stdout:JSON.stringify(records), stderr:''};
    };
    t.after(() => {cp.spawnSync = spawn;});
    assert.throws(() => m[entry](f.j), error => {
      assert.equal(error.message, `managed services not confirmed stopped: scheduler (status=${state.status}, pid=${state.pid}); custom-service (status=online, pid=123)`);
      return true;
    });
    assert.equal(lists, 2);
  });
}

// Real recovery entry points and bounded PM2 children in a private fixture.
// Run for maintenance restart env changes; unrelated upgrade paths can skip.
// Fixture reads HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/private PATH before launch; no
// native daemon, tmux, database or network, and teardown restores/removes paths.
test('maintenance service restarts omit session identity and retain unrelated environment', t => {
  const f = serviceRestartFixture(t); f.custom();
  const injected = { ZYLOS_RUN_ID: 'caller-run', ZYLOS_SESSION_GROUP: 'chat:caller', SERVICE_SENTINEL: 'preserved' };
  const previous = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, injected);
  console.log('Maintenance isolation:', JSON.stringify(f.env));
  m.restartService('custom-service');
  m.start(f.j);
  const children = f.environments().filter(row => ['restart', 'startOrRestart'].includes(row.args[0]));
  assert.equal(children.length, 3);
  assert.equal(children.filter(row => row.args[0] === 'startOrRestart').length, 1);
  for (const row of children) {
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_RUN_ID'), false);
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_SESSION_GROUP'), false);
    assert.equal(row.env.SERVICE_SENTINEL, 'preserved');
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH']) assert.equal(row.env[key], f.env[key]);
  }
  assert.equal(process.env.ZYLOS_RUN_ID, 'caller-run');
  assert.equal(process.env.ZYLOS_SESSION_GROUP, 'chat:caller');
});
