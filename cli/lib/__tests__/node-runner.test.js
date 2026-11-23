import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { testRootPrefix } from '../../../scripts/test-environment.js';

test('test root falls back only for an overlong macOS socket path', () => {
  const nestedSocket = prefix => path.join(`${prefix}XXXXXX`, 'tmp',
    'zylos-pm2-cleanup-XXXXXX', 'home', '.pm2', 'rpc.sock');
  const short = '/tmp';
  assert.equal(testRootPrefix(short, 'darwin'), path.join(short, 'zylos-tests-'));
  const long = path.join('/var/folders', 'a'.repeat(60));
  assert(Buffer.byteLength(nestedSocket(path.join(long, 'zylos-tests-'))) >= 104);
  const selected = testRootPrefix(long, 'darwin');
  assert.equal(selected, '/tmp/zylos-tests-');
  assert(Buffer.byteLength(nestedSocket(selected)) < 104);
  // Linux retains the exact pre-change mkdtemp prefix, even with a long TMPDIR.
  assert.equal(testRootPrefix(long, 'linux'), path.join(long, 'zylos-tests-'));
  assert.equal(testRootPrefix(short, 'linux'), path.join(short, 'zylos-tests-'));
  const baseBytes = Buffer.byteLength(nestedSocket('/zylos-tests-'));
  for (const bytes of [103, 104]) {
    const tmpdir = `/${'x'.repeat(bytes - baseBytes - 1)}`;
    const prefix = path.join(tmpdir, 'zylos-tests-');
    assert.equal(Buffer.byteLength(nestedSocket(prefix)), bytes);
    assert.equal(testRootPrefix(tmpdir, 'darwin'), bytes === 104 ? '/tmp/zylos-tests-' : prefix);
  }
  const multibyte = `/${'界'.repeat(Math.ceil((104 - baseBytes - 1) / 3))}`;
  const multibyteSocket = nestedSocket(path.join(multibyte, 'zylos-tests-'));
  assert(multibyteSocket.length < 104);
  assert(Buffer.byteLength(multibyteSocket) >= 104);
  assert.equal(testRootPrefix(multibyte, 'darwin'), '/tmp/zylos-tests-');
});

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

// Runner CLI boundary: use real runner children and test modules, isolated
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, no sockets, databases, tmux or PM2.
// Run for argument/filter/reporter changes; unrelated product changes may skip.
// The outer runner and t.after own all files; every child has a fixed deadline.
for (const entry of [
  { name: 'rejects an unmatched name', args: ['--test-name-pattern=^absent case$'], status: 1, error: /No tests matched/ },
  { name: 'runs a matched name', args: ['--test-name-pattern=^selected success$'], status: 0, receipt: 'success' },
  { name: 'retains a selected explicit gate skip', args: ['--test-name-pattern=^selected skip$'], status: 0 },
  { name: 'runs children of a matched suite', args: ['--test-name-pattern=^selected suite$'], status: 0, receipt: 'child' },
  { name: 'propagates a selected test failure', args: ['--test-name-pattern=^selected failure$'], status: 1 },
  { name: 'rejects an empty name pattern', args: ['--test-name-pattern='], status: 1, error: /nonempty/ },
  { name: 'explains the separated pattern syntax', args: ['--test-name-pattern', '^selected success$'], status: 1, error: /Use --test-name-pattern=<pattern> as one argument/ },
  { name: 'rejects listing with a name pattern', args: ['--list', '--test-name-pattern=selected'], status: 1, error: /--list cannot be combined/ },
  { name: 'lists without loading tests', args: ['--list'], status: 0 },
]) test(`Node runner ${entry.name}`, t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-filter-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  copyRunnerSources(fixture);
  fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  const tests = path.join(fixture, 'cli/lib/__tests__');
  fs.mkdirSync(tests, { recursive: true });
  const receipt = path.join(fixture, 'executed.txt');
  fs.writeFileSync(path.join(tests, 'fixture.test.js'), `
    import { test, describe } from 'node:test';
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    test('selected success', () => fs.writeFileSync(${JSON.stringify(receipt)}, 'success'));
    test('selected skip', { skip: 'fixture gate disabled' }, () => assert.fail('gate must skip'));
    test('selected failure', () => assert.fail('selected fixture failure'));
    describe('selected suite', () => {
      test('child', () => fs.writeFileSync(${JSON.stringify(receipt)}, 'child'));
    });
  `);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const files = entry.args.includes('--list') ? [] : ['cli/lib/__tests__/fixture.test.js'];
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/run-node-tests.js'), ...entry.args, ...files], {
    cwd: fixture, encoding: 'utf8', timeout: 30000, env,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, entry.status, result.stdout + result.stderr);
  if (entry.error) assert.match(result.stdout + result.stderr, entry.error);
  if (entry.receipt) assert.equal(fs.readFileSync(receipt, 'utf8'), entry.receipt);
  else assert.equal(fs.existsSync(receipt), false, 'unselected or skipped bodies must not run');
});


// Discovery boundary: real runner children and temporary test modules only.
// Run for slow-test selection changes; skip for unrelated changes. The outer
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no tmux, PM2 or DB is used.
// Child deadlines and t.after bind all work and files to this test lifecycle.
test('Node runner skips slow bodies by default and runs opted-in or explicit paths', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-slow-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  copyRunnerSources(fixture);
  fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  const tests = path.join(fixture, 'cli/lib/__tests__');
  fs.mkdirSync(tests, { recursive: true });
  const receipt = path.join(fixture, 'executed.txt');
  for (const name of ['ordinary.test.js', 'optional.slow.test.js']) {
    fs.writeFileSync(path.join(tests, name), `
      import test from 'node:test';
      import fs from 'node:fs';
      test('record execution', () => fs.appendFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(name + '\n')}));
    `);
  }
  for (const { slow, files, expected } of [
    { slow: '0', files: [], expected: ['ordinary.test.js'] },
    { slow: '1', files: [], expected: ['optional.slow.test.js', 'ordinary.test.js'] },
    { slow: '0', files: ['cli/lib/__tests__/optional.slow.test.js'], expected: ['optional.slow.test.js'] },
  ]) {
    fs.writeFileSync(receipt, '');
    const env = { ...process.env, ZYLOS_SLOW_TESTS: slow };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/run-node-tests.js'), ...files], {
      cwd: fixture, encoding: 'utf8', timeout: 30000, env,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fs.readFileSync(receipt, 'utf8').trim().split('\n').sort(), expected);
  }
});
