import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ensurePm2LogRotate, isLogRotateInstalled,
} from '../pm2-logrotate.js';
import { fakePm2, processAlive } from './helpers/fake-pm2-logrotate.js';

// Every PM2 call goes to a fake `pm2` first on a PATH without the real one, under
// a private PM2_HOME inside the test temp directory. No network, no live PM2.



test('existing module keeps every custom value and receives no PM2 command', async t => {
  const f = fakePm2(t);
  f.writeConf({
    'module-db-v2': { 'pm2-logrotate': {} },
    'pm2-logrotate': { max_size: '50M', retain: '3', compress: false, workerInterval: '120', rotateInterval: '0 3 * * 1', TZ: 'Asia/Singapore' },
  });
  const before = fs.readFileSync(f.confFile);
  const result = await ensurePm2LogRotate({ env: f.env });
  assert.deepEqual(result, { state: 'present' });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(fs.readFileSync(f.confFile), before);
});

test('install timeout stops pm2 and the npm process it started within the deadline', async t => {
  const f = fakePm2(t, { mode: 'timeout' });
  const started = Date.now();
  const result = await ensurePm2LogRotate({ env: f.env, timeouts: { set: 10_000, install: 1_500 } });
  const elapsed = Date.now() - started;
  assert.equal(result.state, 'failed');
  assert.match(result.warning, /pm2 install did not finish within 2 s/);
  assert.match(result.warning, /Install it later with: /);
  assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
  const child = f.childPid();
  const deadline = Date.now() + 5_000;
  while (processAlive(child) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(processAlive(child), false, 'npm-like child of pm2 install is stopped');
  assert.equal(isLogRotateInstalled(f.pm2Home), false);
});
