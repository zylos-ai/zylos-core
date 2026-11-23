import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchEnvironment, writeSessionLaunchScript } from '../session-command.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const socketDirectory of [undefined, '', '/tmp/private tmux sockets']) {
  test(`clean launch environment inherits a ${socketDirectory === undefined ? 'missing' : socketDirectory === '' ? 'blank' : 'configured'} tmux directory`, t => {
    const root = fixture(t);
    const processEnv = { HOME: root, PATH: '/bin', TMUX: '/tmp/parent.sock,1,0', TMUX_PANE: '%1' };
    if (socketDirectory !== undefined) processEnv.TMUX_TMPDIR = socketDirectory;
    const env = launchEnvironment(root, processEnv);
    if (socketDirectory) assert.equal(env.TMUX_TMPDIR, socketDirectory);
    else assert.equal(Object.hasOwn(env, 'TMUX_TMPDIR'), false);
    assert.equal(Object.hasOwn(env, 'TMUX'), false);
    assert.equal(Object.hasOwn(env, 'TMUX_PANE'), false);
    assert.equal(env.ZYLOS_DIR, root);
  });
}

// Integration boundary: real dotenv -> environment policy -> generated shell ->
// a Node child, with no tmux, PM2, database or native runtime. Run when dotenv
// parsing, tmux socket-directory inheritance or launch-script environment serialization changes; skip otherwise.
// The runner isolates HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR before imports.
test('session launch script passes parsed dotenv values to a real child', t => {
  const root = fixture(t);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(os.tmpdir().split('/zylos-tests-')[0] + '/zylos-tests-'), key);
  }
  console.log('isolated launch paths', JSON.stringify(Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))));
  fs.writeFileSync(path.join(root, '.env'), 'ZYLOS_TMUX_ENV=EXPORTED,COMMENTED\nexport EXPORTED="fixture # literal"\nCOMMENTED=first\nCOMMENTED=last # comment\n');
  const socketDirectory = path.join(root, 'tmux sockets');
  const env = launchEnvironment(root, { HOME: process.env.HOME, PATH: '/bin', TMUX_TMPDIR: socketDirectory });
  const script = writeSessionLaunchScript({ root, env, multi: false,
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({exported:process.env.EXPORTED,commented:process.env.COMMENTED,root:process.cwd(),tmuxTmpdir:process.env.TMUX_TMPDIR,tmux:process.env.TMUX}))'],
  });
  t.after(() => script.cleanup());
  const result = JSON.parse(execFileSync('/bin/sh', [script.file], {
    cwd: root, env: { ...process.env, ZYLOS_RUN_ID: 'fixture', ZYLOS_MODEL_CONFIG: '{}', TMUX: '/tmp/parent.sock,1,0' },
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  }));
  assert.equal(result.exported, 'fixture # literal');
  assert.equal(result.commented, 'last');
  assert.equal(result.root, root);
  assert.equal(result.tmuxTmpdir, socketDirectory);
  assert.equal(Object.hasOwn(result, 'tmux'), false);
  assert.equal(fs.existsSync(script.file), false);
});
