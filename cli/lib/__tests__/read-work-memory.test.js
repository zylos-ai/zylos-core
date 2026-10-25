import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { readWorkMemory, parseReadWorkMemoryArgs } from '../read-work-memory.js';

// P07 parser integration is deliberately unverified: this is a consumer fixture.
const lockModule = new URL(process.env.TEST_MEMORY_LOCK_MODULE || '../memory-lock.js', import.meta.url).href;
const { withMemoryLock } = await import(lockModule);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id1 = '20261019T081500123Z', id2 = '20261019T091200456Z';
function fixture(t, grouped = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-work-memory-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'read-1', TMPDIR: root };
  delete env.ZYLOS_SESSION_GROUP;
  if (grouped) env.ZYLOS_SESSION_GROUP = 'origin';
  const memory = path.join(root, 'memory', ...(grouped ? ['session-groups', 'origin'] : []));
  const run = path.join(root, 'activity-monitor', 'session-groups', 'origin');
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'state.md'), 'captured state\n');
  fs.writeFileSync(path.join(memory, 'inbox.md'), 'current inbox\n');
  fs.writeFileSync(path.join(memory, `inbox.${id2}.md`), 'second segment\n');
  fs.writeFileSync(path.join(memory, `inbox.${id1}.md`), 'first segment\n');
  const parseStateHeader = (_text, { scope }) => ({ valid: true, scope, coverage: 42, inboxCommitted: [id1] });
  return { root, env, memory, run, options: { env, withMemoryLock, parseStateHeader } };
}

test('IF-22: same-lock snapshot excludes committed segments, hashes exact bytes and never changes source files', async t => {
  const f = fixture(t);
  const before = Object.fromEntries(fs.readdirSync(f.memory).map(name => [name, fs.readFileSync(path.join(f.memory, name))]));
  let held = false, parseHeld = false;
  const result = await readWorkMemory({ ...f.options,
    withMemoryLock: (run, action, options) => withMemoryLock(run, assertHeld => {
      held = true;
      try { return action(assertHeld); } finally { held = false; }
    }, options),
    parseStateHeader: (text, options) => { parseHeld = held; return f.options.parseStateHeader(text, options); },
    readFile: file => { assert.equal(held, true); return fs.readFileSync(file); },
  });
  assert.equal(parseHeld, true);
  assert.equal(result.data.scope, 'origin');
  assert.deepEqual(result.data.segments.map(part => part.id), [id2]);
  assert.equal(result.data.state.sha256, sha(before['state.md']));
  assert.equal(result.data.state.bytes, before['state.md'].length);
  assert.match(result.data.text, /second segment/);
  assert.doesNotMatch(result.data.text, /first segment/);
  for (const [name, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(f.memory, name)), bytes);
});

test('IF-22: malformed header retains body and includes all segments in ID order', async t => {
  const f = fixture(t);
  const result = await readWorkMemory({ ...f.options,
    parseStateHeader: () => ({ valid: false, scope: null, coverage: null, inboxCommitted: [] }) });
  assert.equal(result.data.state.valid, false);
  assert.deepEqual(result.data.state.inboxCommitted, []);
  assert.deepEqual(result.data.segments.map(part => part.id), [id1, id2]);
  assert.match(result.data.text, /captured state/);
  assert.equal(result.data.warnings.length, 1);
});

test('IF-22: rotate/commit waits until capture releases F8; output uses its original snapshot', async t => {
  const f = fixture(t);
  let change;
  const result = await readWorkMemory({ ...f.options, readFile: file => {
    const bytes = fs.readFileSync(file);
    if (file.endsWith('state.md')) change = withMemoryLock(f.run, () => {
      fs.writeFileSync(path.join(f.memory, 'state.md'), 'new committed state');
      fs.writeFileSync(path.join(f.memory, 'inbox.md'), 'new inbox');
      fs.unlinkSync(path.join(f.memory, `inbox.${id2}.md`));
    });
    return bytes;
  } });
  await change;
  assert.match(result.data.text, /captured state/);
  assert.match(result.data.text, /current inbox/);
  assert.match(result.data.text, /second segment/);
  assert.doesNotMatch(result.data.text, /new committed state/);
});

test('IF-22: large UTF-8 output spills the same captured bytes after unlocking', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.memory, 'state.md'), 'abc '.repeat(12000));
  let held = false;
  const result = await readWorkMemory({ ...f.options,
    withMemoryLock: (run, action, options) => withMemoryLock(run, assertHeld => {
      held = true; try { return action(assertHeld); } finally { held = false; }
    }, options),
    writeFile: (file, bytes, options) => {
      assert.equal(held, false);
      fs.writeFileSync(path.join(f.memory, 'state.md'), 'changed after capture');
      return fs.writeFileSync(file, bytes, options);
    },
  });
  assert.ok(Buffer.byteLength(result.output) < 32768);
  const bytes = fs.readFileSync(result.data.spill.path);
  assert.equal(bytes.length, result.data.spill.bytes);
  assert.equal(sha(bytes), result.data.spill.sha256);
  const snapshot = JSON.parse(bytes).data;
  assert.match(snapshot.text, /abc abc/);
  assert.doesNotMatch(snapshot.text, /changed after capture/);
  assert.equal(snapshot.state.bytes, 48000);
  assert.equal(fs.statSync(result.data.spill.path).mode & 0o777, 0o600);
});

test('IB-23: exactly 32 KiB stays inline and the next UTF-8 byte spills', async t => {
  const f = fixture(t);
  const statePath = path.join(f.memory, 'state.md');
  fs.writeFileSync(statePath, 'x'.repeat(10000));
  const initial = await readWorkMemory(f.options);
  const padding = 32768 - Buffer.byteLength(initial.output);
  assert.ok(padding > 0);
  // Replace three ASCII bytes with one three-byte character to test bytes, not chars.
  const state = '\u4e2d' + 'x'.repeat(9997 + padding);
  fs.writeFileSync(statePath, state);
  const exact = await readWorkMemory(f.options);
  assert.equal(Buffer.byteLength(exact.output), 32768);
  assert.equal(exact.data.spill, undefined);
  assert.equal(exact.data.state.bytes, Buffer.byteLength(state));
  fs.appendFileSync(statePath, 'x');
  const above = await readWorkMemory(f.options);
  const spill = fs.readFileSync(above.data.spill.path);
  assert.equal(spill.length, 32769);
  assert.equal(above.data.spill.sha256, sha(spill));
  assert.equal(JSON.parse(spill).data.text.includes(state + 'x'), true);
});

test('IB-23: expired total budget, non-UTF-8 and spill failure never return partial success', async t => {
  const f = fixture(t);
  let clock = 0, reads = 0;
  await assert.rejects(readWorkMemory({ ...f.options, timeoutMs: 2100, now: () => clock,
    readFile: file => {
      reads++;
      const bytes = fs.readFileSync(file);
      if (file.endsWith('state.md')) clock = 2100;
      return bytes;
    },
  }), error => error.code === 'READ_FAILED' && error.parts.includes('snapshot'));
  assert.equal(reads, 1);
  await withMemoryLock(f.run, assertHeld => assertHeld(), { waitMs: 1000 });
  fs.writeFileSync(path.join(f.memory, 'inbox.md'), Buffer.from([0xff]));
  await assert.rejects(readWorkMemory(f.options), { code: 'READ_FAILED' });
  fs.writeFileSync(path.join(f.memory, 'inbox.md'), 'restored');
  fs.writeFileSync(path.join(f.memory, 'state.md'), 'x'.repeat(40000));
  await assert.rejects(readWorkMemory({ ...f.options, writeFile: () => { throw Error('disk full'); } }),
    error => error.code === 'READ_FAILED' && error.parts[0] === 'spill');
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('zylos-work-memory-')), false);
});

test('IF-22: missing/unreadable part rejects the whole snapshot and identifies the part', async t => {
  const f = fixture(t);
  for (const part of ['state', 'inbox', `segment:${id2}`]) {
    await assert.rejects(readWorkMemory({ ...f.options, readFile: file => {
      if (file === path.join(f.memory, part === 'state' ? 'state.md' : part === 'inbox' ? 'inbox.md' : `inbox.${id2}.md`)) {
        throw Object.assign(Error('permission denied'), { code: 'EACCES' });
      }
      return fs.readFileSync(file);
    } }), error => error.code === 'READ_FAILED' && error.parts[0] === part);
  }
  fs.unlinkSync(path.join(f.memory, 'inbox.md'));
  await assert.rejects(readWorkMemory(f.options), error => error.code === 'READ_FAILED' && error.parts[0] === 'inbox');
});

test('IB-23: environment scope only, global and grouped reads cannot fall back across scopes', async t => {
  const global = fixture(t, false);
  assert.equal((await readWorkMemory(global.options)).data.scope, '*');
  delete global.env.ZYLOS_RUN_ID;
  assert.equal((await readWorkMemory(global.options)).data.scope, '*');
  const f = fixture(t);
  f.env.ZYLOS_SESSION_GROUP = '';
  await assert.rejects(readWorkMemory(f.options), { code: 'SCOPE_INVALID' });
  f.env.ZYLOS_SESSION_GROUP = 'origin';
  fs.unlinkSync(path.join(f.memory, 'state.md'));
  fs.mkdirSync(path.join(f.root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'memory/state.md'), 'wrong-scope secret marker');
  await assert.rejects(readWorkMemory(f.options), error => error.code === 'READ_FAILED' && !error.message.includes('wrong-scope'));
});

test('IF-22: timeout cancels lock wait before returning and does not read without lock', async t => {
  const f = fixture(t);
  let release, signalHeld;
  const held = new Promise(resolve => { signalHeld = resolve; });
  const holder = withMemoryLock(f.run, async () => { signalHeld(); await new Promise(resolve => { release = resolve; }); });
  await held;
  const started = Date.now();
  let readAttempts = 0;
  try {
    await assert.rejects(readWorkMemory({ ...f.options, timeoutMs: 2250,
      readFile: () => { readAttempts++; throw Error('must not read without F8'); } }), { code: 'LOCK_TIMEOUT' });
    assert.ok(Date.now() - started < 2250);
  } finally { release(); await holder; }
  await withMemoryLock(f.run, assertHeld => assertHeld(), { waitMs: 1000 });
  // A Promise.race-only timeout would let its abandoned waiter read after release.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(readAttempts, 0);
});

test('IF-22: a SIGSTOP holder times out without a surviving waiter or source reads', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withMemoryLock } from ${JSON.stringify(lockModule)};
    await withMemoryLock(${JSON.stringify(f.run)}, async () => {
      process.stdout.write('held\\n');
      process.kill(process.pid, 'SIGSTOP');
      await new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume(); });
    });
  `], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGCONT'); child.stdin.end(); }
    await closed;
  });
  await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(Error('Holder did not acquire F8')), 5000);
    child.stdout.on('data', chunk => {
      text += chunk;
      if (text.includes('held\n')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
  });
  let reads = 0;
  await assert.rejects(readWorkMemory({ ...f.options, timeoutMs: 2300,
    readFile: () => { reads++; throw Error('unexpected read'); } }), { code: 'LOCK_TIMEOUT' });
  assert.equal(child.exitCode, null);
  child.kill('SIGCONT'); child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  await withMemoryLock(f.run, assertHeld => assertHeld(), { waitMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads, 0);
});

test('IB-23: malformed flags reject and missing P07 parser is explicit READ_FAILED', async t => {
  for (const args of [['--group', 'origin'], ['--unknown'], ['--json', '--json'], ['--timeout-ms'],
    ['--timeout-ms', '0'], ['--timeout-ms', '2000'], ['--timeout-ms', '2.5'], ['--timeout-ms', '10000', '--timeout-ms', '10000']]) {
    assert.throws(() => parseReadWorkMemoryArgs(args), { code: 'INVALID_ARGS' });
  }
  const f = fixture(t);
  await assert.rejects(readWorkMemory({ ...f.options, parseStateHeader: undefined }), error => error.code === 'READ_FAILED' && error.parts[0] === 'dependencies');
  const script = new URL('../../../skills/zylos-memory/scripts/read-work-memory.js', import.meta.url);
  const exec = promisify(execFile);
  for (const args of [['--json', '--group', 'origin'], ['--json']]) {
    let failure;
    try { await exec(process.execPath, [script.pathname, ...args], { env: f.env }); }
    catch (cause) { failure = cause; }
    assert.equal(failure.code, 1);
    const output = JSON.parse(failure.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, args.includes('--group') ? 'INVALID_ARGS' : 'READ_FAILED');
    assert.deepEqual(output.error.persisted, []);
  }
});
