import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../..');
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
