import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { queryComponentSessionGroup, fixedAddressSessionGroup } from '../c4-component-session-group.js';

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

test('query skips missing and nonfile scripts and null addresses', async t => {
  const f = fixture(t);
  assert.equal(f.query('address'), null);
  fs.mkdirSync(f.script);
  assert.equal(f.query('address'), null);
  fs.rmdirSync(f.script);
  fs.writeFileSync(f.script, 'process.exit(19);');
  assert.equal(f.query(null), null);
});

test('query preserves the address argument working directory environment and stdin EOF', async t => {
  const f = fixture(t, `import fs from 'node:fs';
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', value => { input += value; });
    process.stdin.on('end', () => {
      fs.writeFileSync(process.env.QUERY_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), value: process.env.QUERY_VALUE, input }));
      process.stdout.write('Room_A:one\\n');
    });`);
  f.env.QUERY_CAPTURE = path.join(f.root, 'capture.json');
  f.env.QUERY_VALUE = 'literal $value `no shell`';
  const endpoint = 'a\'"$`\\\nroute|id:2';
  console.log('Component query isolation:', JSON.stringify({ HOME: f.env.HOME, ZYLOS_DIR: f.env.ZYLOS_DIR,
    PM2_HOME: f.env.PM2_HOME, TMPDIR: f.env.TMPDIR, cwd: f.component, database: 'none', tmux: 'not spawned' }));
  assert.equal(f.query(endpoint), 'Room_A:one');
  const capture = JSON.parse(fs.readFileSync(f.env.QUERY_CAPTURE, 'utf8'));
  assert.equal(capture.args.length, 1);
  assert.equal(capture.args[0], endpoint);
  assert.equal(capture.cwd, f.component);
  assert.equal(capture.value, f.env.QUERY_VALUE);
  assert.equal(capture.input, '');
});

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

test('query rejects whitespace extra newlines invalid characters and overlong names', async t => {
  const f = fixture(t, 'process.stdout.write(process.env.QUERY_OUTPUT);');
  for (const output of [' Room', 'Room ', 'Room\n\n', 'Room\r', '-room', 'a/b', 'a|b', 'a'.repeat(96)]) {
    f.env.QUERY_OUTPUT = output;
    assert.throws(() => f.query('address'), failed(/invalid output/));
  }
});

test('query rejects nonzero exit and limits multibyte stderr to 200 characters', async t => {
  const f = fixture(t, "process.stderr.write('界'.repeat(1000), () => process.exit(7));");
  assert.throws(() => f.query('address'), error => {
    failed(/exit code 7/)(error);
    const diagnostic = error.message.match(/; stderr: (.*?)\)$/s)[1];
    assert.equal([...diagnostic].length, 200);
    assert.equal(diagnostic, '界'.repeat(200));
    return true;
  });
});

test('query bounds stderr without rejecting valid stdout or caching ownership', t => {
  const f = fixture(t, "process.stderr.write('x'.repeat(100000)); process.stdout.write(process.env.QUERY_OUTPUT);");
  for (const groupName of ['first', 'second']) {
    f.env.QUERY_OUTPUT = groupName;
    assert.deepEqual(queryComponentSessionGroup({ component: 'demo', endpoint: 'address' }, { skillsDir: f.root, env: f.env }), { groupName });
  }
});

test('query accepts the stdout byte ceiling for validation and kills overflow before returning', { timeout: 10000 }, async t => {
  const f = fixture(t, `import fs from 'node:fs';
    fs.writeFileSync(process.env.QUERY_PID_FILE, String(process.pid));
    process.stdout.write(process.env.QUERY_OUTPUT);
    if (process.env.QUERY_LOOP === 'yes') setInterval(() => process.stdout.write('more'), 10);`);
  f.env.QUERY_OUTPUT = 'a'.repeat(4096);
  assert.throws(() => f.query('address'), failed(/invalid output/));
  reaped(f.pidFile);
  f.env.QUERY_OUTPUT = '界'.repeat(1366);
  f.env.QUERY_LOOP = 'yes';
  assert.throws(() => f.query('address'), failed(/stdout exceeded 4096 bytes/));
  reaped(f.pidFile);
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

test('query reports a component spawn failure independently of PATH', async t => {
  const f = fixture(t, "process.stdout.write('room');");
  f.env.ZYLOS_DIR = f.root;
  f.env.NODE_OPTIONS = `--import=${fileURLToPath(new URL('./fixtures/send-spawn-fault.js', import.meta.url))}`;
  f.env.C4_TEST_SPAWN_TARGET = f.script;
  f.env.C4_TEST_SPAWN_FAULT = 'ENOENT';
  assert.throws(() => f.query('address'), failed(/could not start: ENOENT/));
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

// Boundary: a test-owned preload retains only the runner's event loop. The
// synchronous caller must kill it even after the component already exited.
test('query bounds a runner that remains alive after component completion', { timeout: 10000 }, t => {
  const f = fixture(t, "process.stdout.write('room');");
  f.env.NODE_OPTIONS = `--import=${fileURLToPath(new URL('./fixtures/query-runner-linger.js', import.meta.url))}`;
  const start = Date.now();
  assert.throws(() => f.query('address'), failed(/could not start: ETIMEDOUT/));
  assert.ok(Date.now() - start >= 6400);
  assert.ok(Date.now() - start < 8000);
});

// Same private query boundary. An inherited pipe must not extend Core's timeout.
// The bounded descendant is stopped explicitly before fixture teardown.
test('query timeout settles when a descendant retains inherited output pipes', { timeout: 10000 }, async t => {
  let descendantFile;
  const stopped = pid => {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') {
        return /^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      }
      return false;
    } catch (error) {
      if (error.code === 'ESRCH' || error.code === 'ENOENT') return true;
      throw error;
    }
  };
  const stopDescendant = async () => {
    if (!descendantFile || !fs.existsSync(descendantFile)) return;
    const pid = Number(fs.readFileSync(descendantFile, 'utf8'));
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 1500;
    while (!stopped(pid) && Date.now() < deadline) await delay(20);
    assert.equal(stopped(pid), true, 'fixture descendant must be stopped');
    fs.unlinkSync(descendantFile);
  };
  t.after(stopDescendant);
  const f = fixture(t, `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    fs.writeFileSync(process.env.QUERY_PID_FILE, String(process.pid));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 15000)'], { stdio: 'inherit' });
    fs.writeFileSync(process.env.QUERY_DESCENDANT_PID_FILE, String(child.pid));
    setInterval(() => {}, 1000);`);
  descendantFile = path.join(f.root, 'descendant.pid');
  f.env.QUERY_DESCENDANT_PID_FILE = descendantFile;
  const start = Date.now();
  assert.throws(() => f.query('address'), failed(/timed out after 5 s/));
  assert.ok(Date.now() - start >= 4900);
  assert.ok(Date.now() - start < 6500);
  reaped(f.pidFile);
  await stopDescendant();
});

test('shared ownership exports return synchronous results and exact fixed addresses', t => {
  const f = fixture(t);
  assert.deepEqual(queryComponentSessionGroup({ component: 'demo', endpoint: 'address' }, { skillsDir: f.root, env: f.env }), { groupName: null });
  assert.equal(fixedAddressSessionGroup('dashboard', 'origin'), 'origin');
  for (const [component, endpoint] of [['demo', 'origin'], ['dashboard', 'other'], ['dashboard', null]]) {
    assert.equal(fixedAddressSessionGroup(component, endpoint), null);
  }
});
