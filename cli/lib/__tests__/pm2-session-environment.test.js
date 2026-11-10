import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createPm2Helpers } from '../pm2.js';
import { registerService } from '../service.js';

// Real child launch with a private PM2 stand-in; run for service environment
// changes, skip unrelated lifecycle work. No daemon, tmux, database or network.
// Private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/PATH are read back before launch.
// Each child has a timeout/output bound and exits; teardown restores env/paths.
test('PM2 startup children omit session identity and retain service environment', { timeout: 10000 }, t => {
  const root = fs.mkdtempSync('/tmp/pm2-env-');
  const bin = path.join(root, 'bin'), capture = path.join(root, 'captured.jsonl');
  const env = { HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'),
    PATH: bin, PM2_TEST_CAPTURE: capture, SERVICE_SENTINEL: 'preserved',
    ZYLOS_RUN_ID: 'caller-run', ZYLOS_SESSION_GROUP: 'chat:caller' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of [bin, env.HOME, env.ZYLOS_DIR, env.PM2_HOME, env.TMPDIR]) fs.mkdirSync(dir, { recursive: true });
  const fixture = fileURLToPath(new URL('../../../test/fixtures/capture-pm2-environment.js', import.meta.url));
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o700 });
  Object.assign(process.env, env);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH']) {
    assert.ok(process.env[key].startsWith(root + path.sep), key);
  }
  assert.deepEqual(fs.readdirSync(bin), ['pm2']);
  console.log('PM2 child isolation:', JSON.stringify({ ...env, fixture }));
  const ecosystem = path.join(root, 'ecosystem.config.cjs'); fs.writeFileSync(ecosystem, 'module.exports={apps:[]};');
  const helpers = createPm2Helpers({ exec: (command, options) => execSync(command, { ...options, timeout: 3000, maxBuffer: 65536 }) });
  helpers.restartFromEcosystem(['private-service'], { ecosystemPath: ecosystem });
  const skillDir = path.join(root, 'component'); fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'main.js'), '');
  assert.equal(registerService({ name: 'private', entry: 'main.js', skillDir, type: 'pm2' }).success, true);
  fs.writeFileSync(path.join(skillDir, 'ecosystem.config.cjs'), 'module.exports={apps:[]};');
  assert.equal(registerService({ name: 'private', entry: 'main.js', skillDir, type: 'pm2' }).success, true);
  const starts = fs.readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.argv[0] === 'start');
  assert.equal(starts.length, 3);
  assert.deepEqual(starts[0].argv, ['start', ecosystem, '--only', 'private-service', '--update-env']);
  for (const row of starts) {
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_RUN_ID'), false);
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_SESSION_GROUP'), false);
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH', 'SERVICE_SENTINEL']) assert.equal(row.env[key], env[key]);
  }
  assert.equal(process.env.ZYLOS_RUN_ID, 'caller-run');
  assert.equal(process.env.ZYLOS_SESSION_GROUP, 'chat:caller');
});
