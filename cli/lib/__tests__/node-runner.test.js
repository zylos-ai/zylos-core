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
// Integration boundary: real runner children, isolated HOME/ZYLOS_DIR/PM2_HOME
// and temporary files only. Run for runner path/discovery/cleanup changes; skip
// for unrelated runtime changes. The child runner and t.after remove resources.
for (const fail of [false, true]) test(`Node runner ${fail ? 'retains failed temporary evidence and removes isolated home' : 'cleans successful temporary evidence'}`, t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runner-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
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
  fs.cpSync(path.join(root, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
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
