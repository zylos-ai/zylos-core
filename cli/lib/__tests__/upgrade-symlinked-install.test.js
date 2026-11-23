import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

// The journal records the real install path (the upgrade entry resolves
// ZYLOS_DIR), while PM2 and ps keep the path a process was launched with.
function symlinkedInstall(t) {
  const f = serviceRestartFixture(t);
  const link = path.join(f.root, 'linked-zylos');
  fs.symlinkSync(f.env.ZYLOS_DIR, link);
  const linked = file => path.join(link, path.relative(f.env.ZYLOS_DIR, file));
  assert.equal(fs.realpathSync(linked(f.scripts.scheduler)), f.scripts.scheduler);
  assert.ok(!linked(f.scripts.scheduler).includes(f.env.ZYLOS_DIR));
  return {...f, link, linked};
}
function online(f, script) {
  return ['scheduler', 'custom-service'].map(name => ({name, pid:123, pm2_env:{status:'online', pm_exec_path:script(name)}}));
}


test('stopping a symlinked install stops every PM2 service recorded through the symlink', t => {
  const f = symlinkedInstall(t);
  f.records(online(f, name => f.linked(f.scripts[name])));
  m.stop(f.j);
  assert.deepEqual(f.calls().filter(call => call[0] === 'stop'), [['stop', 'scheduler'], ['stop', 'custom-service']]);
  assert.ok(f.records().every(record => record.pm2_env.status === 'stopped' && record.pid === 0));
});
