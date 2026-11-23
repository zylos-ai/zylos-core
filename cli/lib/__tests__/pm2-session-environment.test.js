import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Real command/init entry points with a private PM2 executable and empty skill
// install. Run for startup environment changes; unrelated UI can skip. No live
// daemon, database, tmux or network; child validates paths before product import.
// The bounded child and all PM2 stand-ins exit before fixture teardown.
for (const mode of ['ecosystem', 'fallback', 'init']) test(`${mode} service startup omits session identity in PM2 children`, { timeout: 15000 }, t => {
  const root = fs.mkdtempSync('/tmp/pm2-start-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), capture = path.join(root, 'captured.jsonl');
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'),
    PATH: bin, PM2_TEST_CAPTURE: capture, PM2_TEST_ROOT: root, SERVICE_SENTINEL: 'preserved',
    ZYLOS_RUN_ID: 'caller-run', ZYLOS_SESSION_GROUP: 'chat:caller' };
  if (mode === 'fallback') env.PM2_TEST_FAIL_FIRST_START = path.join(root, 'first-start');
  for (const dir of [bin, env.HOME, env.ZYLOS_DIR, env.PM2_HOME, env.TMPDIR]) fs.mkdirSync(dir, { recursive: true });
  const fixture = fileURLToPath(new URL('../../../test/fixtures/capture-pm2-environment.js', import.meta.url));
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o700 });
  const entry = fileURLToPath(new URL('../../../test/fixtures/start-services-environment.js', import.meta.url));
  const output = execFileSync(process.execPath, [entry, mode], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.match(output, /Startup child isolation:/);
  const starts = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.argv[0] === 'start');
  assert.equal(starts.length, mode === 'fallback' ? 2 : 1);
  if (mode === 'fallback') assert.ok(fs.existsSync(env.PM2_TEST_FAIL_FIRST_START));
  for (const row of starts) {
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_RUN_ID'), false);
    assert.equal(Object.hasOwn(row.env, 'ZYLOS_SESSION_GROUP'), false);
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH', 'SERVICE_SENTINEL']) assert.equal(row.env[key], env[key]);
  }
});
