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

for (const clean of [true, false]) {
  test(`launch environment parses dotenv assignments with clean mode ${clean}`, t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, '.env'), [
      `ZYLOS_CLEAN_ENV=${clean}`,
      'ZYLOS_TMUX_ENV=EXPORTED,COMMENTED,SINGLE,DOUBLE,DUPLICATE,EMPTY',
      '', '# ignored', '   # EXPORTED=ignored',
      'export EXPORTED=one', 'COMMENTED=x # trailing comment',
      "SINGLE='single # literal'", 'DOUBLE="double # literal" # comment',
      'DUPLICATE=first', 'DUPLICATE=last', 'EMPTY=',
    ].join('\n'));
    const processEnv = { HOME: root, PATH: '/bin', EXPORTED: 'stale', ZYLOS_RUN_ID: 'parent' };
    const env = launchEnvironment(root, processEnv);
    for (const [key, value] of Object.entries({
      EXPORTED: 'one', COMMENTED: 'x', SINGLE: 'single # literal',
      DOUBLE: 'double # literal', DUPLICATE: 'last', EMPTY: '',
    })) assert.equal(env[key], value, key);
    assert.equal(env.ZYLOS_RUN_ID, undefined);
    assert.equal(env.ZYLOS_DIR, root);
    assert.equal(processEnv.EXPORTED, 'stale');
    assert.equal(processEnv.ZYLOS_RUN_ID, 'parent');
  });
}

test('launch environment retains missing-file defaults and propagates read errors', t => {
  const root = fixture(t);
  assert.equal(launchEnvironment(root, { HOME: root, PATH: '/bin' }).ZYLOS_DIR, root);
  fs.mkdirSync(path.join(root, '.env'));
  assert.throws(() => launchEnvironment(root, { HOME: root }), { code: 'EISDIR' });
});

// Integration boundary: real dotenv -> environment policy -> generated shell ->
// a Node child, with no tmux, PM2, database or native runtime. Run when dotenv
// parsing or launch-script environment serialization changes; skip otherwise.
// The runner isolates HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR before imports.
test('session launch script passes parsed dotenv values to a real child', t => {
  const root = fixture(t);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(os.tmpdir().split('/zylos-tests-')[0] + '/zylos-tests-'), key);
  }
  console.log('isolated launch paths', JSON.stringify(Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))));
  fs.writeFileSync(path.join(root, '.env'), 'ZYLOS_TMUX_ENV=EXPORTED,COMMENTED\nexport EXPORTED="fixture # literal"\nCOMMENTED=first\nCOMMENTED=last # comment\n');
  const env = launchEnvironment(root, { HOME: process.env.HOME, PATH: '/bin' });
  const script = writeSessionLaunchScript({ root, env, multi: false,
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({exported:process.env.EXPORTED,commented:process.env.COMMENTED,root:process.cwd()}))'],
  });
  t.after(() => script.cleanup());
  const result = JSON.parse(execFileSync('/bin/sh', [script.file], {
    cwd: root, env: { ...process.env, ZYLOS_RUN_ID: 'fixture', ZYLOS_MODEL_CONFIG: '{}' },
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  }));
  assert.equal(result.exported, 'fixture # literal');
  assert.equal(result.commented, 'last');
  assert.equal(result.root, root);
  assert.equal(fs.existsSync(script.file), false);
});
