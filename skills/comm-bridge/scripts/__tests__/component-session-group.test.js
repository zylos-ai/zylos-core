import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryComponentSessionGroup } from '../c4-component-session-group.js';

function fixture(t, source) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key], `isolated ${key} is required`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-query-'));
  const component = path.join(root, 'demo');
  const script = path.join(component, 'scripts', 'session-group.js');
  const pidFile = path.join(root, 'child.pid');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(path.join(component, 'package.json'), '{"type":"module"}');
  if (source !== undefined) fs.writeFileSync(script, source);
  const env = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH'].map(key => [key, process.env[key]]));
  env.QUERY_PID_FILE = pidFile;
  t.after(() => {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, component, script, pidFile, env,
    query: endpoint => queryComponentSessionGroup({ component: 'demo', endpoint }, { skillsDir: root, env }).groupName };
}

function failed(reason) {
  return error => {
    assert.equal(error.code, 'SESSION_GROUP_QUERY_FAILED');
    assert.match(error.message, reason);
    assert.equal(typeof error.reason, 'string');
    assert.ok(error.reason.length < 512);
    assert.ok([...error.stderr].length <= 200);
    return true;
  };
}

function reaped(pidFile) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  fs.unlinkSync(pidFile);
}

test('query removes exactly one final newline and maps empty output to the whole group', async t => {
  const f = fixture(t, 'process.stdout.write(process.env.QUERY_OUTPUT);');
  for (const output of ['Room', 'Room\n', 'Room\r\n', 'a'.repeat(95) + '\n']) {
    f.env.QUERY_OUTPUT = output;
    assert.equal(f.query('address'), output.replace(/\r?\n$/, ''));
  }
  for (const output of ['', '\n', '\r\n']) {
    f.env.QUERY_OUTPUT = output;
    assert.equal(f.query('address'), null);
  }
});

// Boundary: the real query child only; no component delivery, database, or runtime.
// Run when changing query process limits or lifecycle; skip for formatting-only changes.
test('query times out after five seconds and reaps the child before rejecting', { timeout: 10000 }, async t => {
  const f = fixture(t, `import fs from 'node:fs';
    fs.writeFileSync(process.env.QUERY_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);`);
  const start = Date.now();
  assert.throws(() => f.query('address'), failed(/timed out after 5 s/));
  assert.ok(Date.now() - start >= 4900);
  assert.ok(Date.now() - start < 6500);
  reaped(f.pidFile);
});

test('query accepts path-safe legacy component names and refuses traversal', t => {
  const f = fixture(t);
  for (const component of ['Demo', 'a'.repeat(33)]) {
    assert.deepEqual(queryComponentSessionGroup({ component, endpoint: 'address' }, { skillsDir: f.root, env: f.env }), { groupName: null });
    const directory = path.join(f.root, component, 'scripts');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'session-group.js'), "process.stdout.write('room');");
    assert.deepEqual(queryComponentSessionGroup({ component, endpoint: 'address' }, { skillsDir: f.root, env: f.env }), { groupName: 'room' });
  }
  for (const component of ['', '..', '../demo', 'a/b', 'a\\b', 'a\0b']) {
    assert.throws(() => queryComponentSessionGroup({ component, endpoint: 'address' }, { skillsDir: f.root, env: f.env }), failed(/invalid component/));
  }
});
