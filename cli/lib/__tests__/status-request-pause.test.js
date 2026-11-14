import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStatus } from '../status-view.js';
import { RestartRequestStore } from '../../../skills/activity-monitor/scripts/restart-request-store.js';

test('status uses the request store validator and clears pause after repair', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-requests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'restart-requests.json'), store = new RestartRequestStore({ file });
  const deps = { requests: () => store.read(), mode: () => ({ mode: 'single' }), configIssue: () => null,
    resolveRoot: () => {}, runtimes: [], session: () => ({ identity: { present: false },
      status: { valid: false, reason: 'not_running', sampledAt: null } }) };
  assert.equal((await collectStatus(deps)).supervisorPaused, false, 'missing file is readable empty intent');
  for (const content of ['broken', '{}', '[{"unexpected":true}]']) {
    fs.writeFileSync(file, content);
    assert.equal((await collectStatus(deps)).supervisorPaused, true);
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'status is read only');
  }
  fs.writeFileSync(file, '[]');
  assert.equal((await collectStatus(deps)).supervisorPaused, false);
});

// Boundary: uninjected collectStatus reader and the supervisor's actual default
// store share the private instance file. Run for default-path/status wiring;
// unrelated presentation changes may skip. Runner paths and this fixture are
// isolated; all other readers are injected, so no tmux, database or daemon runs.
test('status default reader observes the supervisor request file in the instance data directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-default-requests-'));
  const previous = process.env.ZYLOS_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.ok(previous);
  assert.notEqual(path.resolve(previous), path.join(os.userInfo().homedir, 'zylos'));
  process.env.ZYLOS_DIR = root;
  const file = path.join(root, 'activity-monitor', 'restart-requests.json');
  const store = new RestartRequestStore();
  assert.equal(store.file, file);
  const deps = { mode: () => ({ mode: 'single' }), configIssue: () => null,
    resolveRoot: () => {}, runtimes: [], session: () => ({ identity: { present: false },
      status: { valid: false, reason: 'not_running', sampledAt: null } }) };
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, requestFile: file,
    tmux: 'unused', database: 'unused' }));
  assert.equal(Object.hasOwn(deps, 'requests'), false);
  assert.equal((await collectStatus(deps)).supervisorPaused, false);
  fs.mkdirSync(path.dirname(file));
  for (const content of ['broken', '{}']) {
    fs.writeFileSync(file, content);
    assert.throws(() => store.read(), { code: 'requests_unreadable' });
    assert.equal((await collectStatus(deps)).supervisorPaused, true);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  store.write([]);
  assert.equal((await collectStatus(deps)).supervisorPaused, false);
});
