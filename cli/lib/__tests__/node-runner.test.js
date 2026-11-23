import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../..');
function copyRunnerSources(fixture) {
  fs.cpSync(path.join(root, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
  const shared = 'skills/comm-bridge/scripts/remove-owned-tree.js';
  const destination = path.join(fixture, shared);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, shared), destination);
}

// Integration boundary: real runner children, isolated HOME/ZYLOS_DIR/PM2_HOME
// and temporary files only. Run for runner path/discovery/cleanup changes; skip
// for unrelated runtime changes. The child runner and t.after remove resources.
for (const fail of [false, true]) test(`Node runner ${fail ? 'retains failed temporary evidence and removes isolated home' : 'cleans successful temporary evidence'}`, t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runner-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  copyRunnerSources(fixture);
  fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  const tests = path.join(fixture, 'cli/lib/__tests__');
  fs.mkdirSync(tests, { recursive: true });
  const receipt = path.join(fixture, 'paths.json');
  fs.writeFileSync(path.join(tests, 'fixture.test.js'), `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    test('fixture evidence', () => {
      const file = path.join(process.env.TMPDIR, 'evidence.txt');
      fs.writeFileSync(file, 'failure evidence');
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({file, home: process.env.HOME}));
      assert.equal(${fail}, false);
    });
  `);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/run-node-tests.js'), 'cli/lib/__tests__/fixture.test.js'], {
    cwd: fixture, encoding: 'utf8', timeout: 30000, env,
  });
  assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
  const paths = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(fs.existsSync(paths.home), false, 'isolated HOME is always cleaned');
  assert.equal(fs.existsSync(paths.file), fail);
  if (fail) {
    assert.equal(fs.readFileSync(paths.file, 'utf8'), 'failure evidence');
    assert.ok(result.stderr.includes(`Test temporary files retained at ${path.dirname(paths.file)}`));
    assert.deepEqual(fs.readdirSync(path.dirname(paths.home)), ['tmp']);
  } else {
    assert.equal(fs.existsSync(path.dirname(paths.home)), false);
    assert.equal(result.stderr.includes('Test temporary files retained'), false);
  }
});

// Isolation boundary: real runner children, two test files and their own child
// processes; isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, no PM2, tmux or databases.
// Run for runner HOME/ZYLOS_DIR assignment changes. The child runner removes the
// homes, t.after the fixture; every child has a fixed deadline.
test('Node runner gives each test file its own HOME and ZYLOS_DIR and keeps child paths', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-homes-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  copyRunnerSources(fixture);
  fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  const tests = path.join(fixture, 'cli/lib/__tests__');
  fs.mkdirSync(tests, { recursive: true });
  for (const name of ['first', 'second']) {
    fs.writeFileSync(path.join(tests, `${name}.test.js`), `
      import test from 'node:test';
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      const child = env => JSON.parse(execFileSync(process.execPath, ['-e',
        'console.log(JSON.stringify([process.env.HOME, process.env.ZYLOS_DIR]))'], { encoding: 'utf8', timeout: 10000, env }));
      test('record paths', () => {
        const given = path.join(process.env.TMPDIR, ${JSON.stringify(name)});
        fs.writeFileSync(${JSON.stringify(path.join(fixture, `${name}.json`))}, JSON.stringify({
          home: process.env.HOME, zylos: process.env.ZYLOS_DIR, pm2: process.env.PM2_HOME, given,
          inherited: child(process.env),
          explicit: child({ ...process.env, HOME: given, ZYLOS_DIR: path.join(given, 'zylos') }),
        }));
      });
    `);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/run-node-tests.js')], {
    cwd: fixture, encoding: 'utf8', timeout: 30000, env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [first, second] = ['first', 'second'].map(name => JSON.parse(fs.readFileSync(path.join(fixture, `${name}.json`), 'utf8')));
  assert.notEqual(first.home, second.home);
  assert.notEqual(first.zylos, second.zylos);
  for (const file of [first, second]) {
    assert.equal(path.dirname(file.home), path.dirname(first.home));
    assert.match(path.basename(path.dirname(file.home)), /^zylos-tests-/);
    assert.equal(file.zylos, path.join(file.home, 'zylos'));
    assert.equal(file.pm2, path.join(file.home, '.pm2'));
    assert.deepEqual(file.inherited, [file.home, file.zylos]);
    assert.deepEqual(file.explicit, [file.given, path.join(file.given, 'zylos')]);
  }
  assert.equal(fs.existsSync(path.dirname(first.home)), false);
});
