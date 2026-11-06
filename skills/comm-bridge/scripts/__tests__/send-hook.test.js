import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { createStore } from '../c4-v2-store.js';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { sendExternal } from '../c4-send-external.js';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.resolve(scripts, '../../..');
const message = 'private test body with $quotes and a newline\nnext line';
const tables = ['conversations', 'channel_namespaces', 'group_heads', 'control_queue'];
const validHook = { hook_id: 'check-send', entry: 'scripts/before-send.js', timeout_ms: 100 };
const frontmatter = c4 => `---\nname: example\nc4: ${JSON.stringify(c4)}\n---\n# Example\n`;

function setup(t, { installed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-hook-'));
  let db;
  const processRecords = [];
  t.after(() => {
    for (const file of processRecords) killRecordedProcesses(file);
    db?.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const skillsDir = path.join(zylos, '.claude', 'skills');
  const tmp = path.join(root, 'tmp'), bin = path.join(root, 'bin');
  for (const dir of [tmp, bin, path.join(zylos, '.zylos'), path.join(zylos, 'comm-bridge'), skillsDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(zylos, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const markers = {};
  function channel(name, declaration) {
    const directory = path.join(skillsDir, name);
    fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    if (declaration !== undefined) fs.writeFileSync(path.join(directory, 'SKILL.md'), declaration);
    markers[name] = path.join(root, `${name}-delivered.json`);
    fs.writeFileSync(path.join(directory, 'scripts', 'send.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(markers[name])}, JSON.stringify(process.argv.slice(2)));`);
    fs.writeFileSync(path.join(directory, 'scripts', 'before-send.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, `${name}-hook-started`))}, 'started');`);
    return directory;
  }
  const x = channel('x'), y = channel('y');
  db = new Database(path.join(zylos, 'comm-bridge', 'c4.db'));
  guardDatabase(db, schema);
  const store = createStore(db, { validateComponent: name => ['x', 'y'].includes(name), readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const calls = { insert: 0, fallback: 0 };
  const api = { ...store, insertConversation: (...args) => { calls.insert++; return store.insertConversation(...args); } };
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'), TMPDIR: tmp, TMUX_TMPDIR: tmp,
    PATH: bin, ZYLOS_PACKAGE_ROOT: packageRoot, ZYLOS_SESSION_GROUP: 'origin' };
  for (const key of Object.keys(env)) {
    if (key === 'TMUX' || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/.test(key) || ['ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)) delete env[key];
  }
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key].startsWith(`${root}${path.sep}`));
  let cli;
  if (installed) {
    const destination = path.join(skillsDir, 'comm-bridge');
    fs.mkdirSync(destination);
    fs.copyFileSync(path.join(scripts, '..', 'package.json'), path.join(destination, 'package.json'));
    fs.copyFileSync(path.join(scripts, '..', 'init-db.sql'), path.join(destination, 'init-db.sql'));
    fs.cpSync(scripts, path.join(destination, 'scripts'), { recursive: true, filter: source => !source.split(path.sep).includes('__tests__') });
    fs.symlinkSync(fs.realpathSync(path.join(scripts, '..', 'node_modules')), path.join(destination, 'node_modules'));
    cli = path.join(destination, 'scripts', 'c4-send.js');
    console.log('Installed send isolation:', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH'].map(key => [key, env[key]]))));
  }
  return { root, x, y, db, api, calls, env, skillsDir, markers, cli, processRecords,
    options: { api, skillsDir, env, appendFallback: async () => { calls.fallback++; } },
    manifest: source => fs.writeFileSync(path.join(x, 'SKILL.md'), source),
    invoke: (channel = 'x', args = []) => spawnSync(process.execPath, [cli, channel, 'private-endpoint', '--stdin', ...args], {
      cwd: root, env, input: `${message}\n`, encoding: 'utf8', timeout: 3000, maxBuffer: 65536
    }) };
}

function noSendSideEffects(f) {
  for (const table of tables) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  assert.equal(f.calls.insert, 0);
  assert.equal(f.calls.fallback, 0);
  assert.equal(fs.existsSync(f.markers.x), false);
  const outbound = path.join(f.env.ZYLOS_DIR, 'comm-bridge', 'receive-events.jsonl');
  assert.equal(fs.existsSync(outbound), false);
}

function empty(f) {
  noSendSideEffects(f);
  assert.equal(fs.existsSync(path.join(f.root, 'x-hook-started')), false);
}

function hook(f, source, timeout_ms = 500) {
  f.manifest(frontmatter({ before_send: { ...validHook, timeout_ms } }));
  fs.writeFileSync(path.join(f.x, 'scripts', 'before-send.js'), source);
}

const output = value => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;

function killRecordedProcesses(file) {
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.ok(Number.isSafeInteger(record.leader) && record.leader > 1);
  try { process.kill(-record.leader, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (const pid of [record.leader, ...record.pids]) {
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

function supervisedHook(f, source, timeoutMs) {
  const file = path.join(f.root, `hook-process-${f.processRecords.length}.json`);
  f.processRecords.push(file);
  hook(f, `import { writeFileSync as writeRecord } from 'node:fs';
    const processRecord={leader:process.pid,pids:[]}; const recordFile=${JSON.stringify(file)};
    writeRecord(recordFile,JSON.stringify(processRecord)); ${source}`, timeoutMs);
  return file;
}

async function boundedHook(f, operation, budgetMs = 2000) {
  let exceeded = false;
  const timer = setTimeout(() => {
    exceeded = true;
    for (const file of f.processRecords) killRecordedProcesses(file);
  }, budgetMs);
  try {
    const result = await operation;
    assert.equal(exceeded, false, 'Hook exceeded the independent fixture deadline');
    return result;
  } finally { clearTimeout(timer); }
}

function processAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (/\) Z /.test(stat)) return false;
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { process.kill(pid, 0); return true; }
    catch (cause) { if (cause.code === 'ESRCH') return false; throw cause; }
  }
}

const malformed = [
  ['broken YAML', '---\nc4: [unterminated\n---\n'],
  ['unterminated frontmatter', '---\nc4: {}\n'],
  ['nonmapping frontmatter', '---\n- c4\n---\n'],
  ['nonmapping declaration', frontmatter([])],
  ['missing hook ID', frontmatter({ before_send: { entry: validHook.entry, timeout_ms: 100 } })],
  ['missing entry', frontmatter({ before_send: { hook_id: validHook.hook_id, timeout_ms: 100 } })],
  ['missing timeout', frontmatter({ before_send: { hook_id: validHook.hook_id, entry: validHook.entry } })],
  ['zero timeout', frontmatter({ before_send: { ...validHook, timeout_ms: 0 } })],
  ['negative timeout', frontmatter({ before_send: { ...validHook, timeout_ms: -1 } })],
  ['nonnumeric timeout', frontmatter({ before_send: { ...validHook, timeout_ms: '100' } })],
  ['infinite timeout', '---\nc4:\n  before_send:\n    hook_id: check-send\n    entry: scripts/before-send.js\n    timeout_ms: .inf\n---\n'],
  ['asynchronous declaration', frontmatter({ before_send: { ...validHook, async: true } })],
  ['HTTP declaration', frontmatter({ before_send: { ...validHook, entry: 'https://example.invalid/check' } })],
  ['unsupported event', frontmatter({ before_receive: validHook })],
  ['hook chain', frontmatter({ before_send: [validHook] })],
  ['outside entry', frontmatter({ before_send: { ...validHook, entry: '../y/scripts/before-send.js' } })],
  ['nonregular entry', frontmatter({ before_send: { ...validHook, entry: 'scripts' } })]
];

for (const [name, source] of malformed) {
  test(`external send rejects ${name} before any routing or persistence`, async t => {
    const f = setup(t); f.manifest(source);
    await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint', groupName: 'missing' }, message, f.options), { code: 'HOOK_INVALID_OUTPUT' });
    empty(f);
  });
}

test('missing channel and missing send entry retain original validation without reading hooks', async t => {
  const f = setup(t); f.manifest('---\nc4: [broken\n---\n');
  await assert.rejects(sendExternal({ channel: 'missing', endpoint: 'private-endpoint' }, message, f.options), { code: 'INVALID_ARGS' });
  fs.renameSync(path.join(f.x, 'scripts', 'send.js'), path.join(f.x, 'scripts', 'send.js.saved'));
  await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'INVALID_ARGS' });
  empty(f);
});

test('absolute and symlink hook entries are rejected before routing', async t => {
  const f = setup(t);
  const outside = path.join(f.y, 'scripts', 'before-send.js');
  fs.symlinkSync(outside, path.join(f.x, 'scripts', 'outside-link.js'));
  for (const entry of [outside, 'scripts/outside-link.js']) {
    f.manifest(frontmatter({ before_send: { ...validHook, entry } }));
    await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'HOOK_INVALID_OUTPUT' });
    empty(f);
  }
});

test('a declaration in another channel cannot block an undeclared channel', async t => {
  const f = setup(t); f.manifest('---\nc4: [broken\n---\n');
  const record = await sendExternal({ channel: 'y', endpoint: 'private-endpoint' }, message, f.options);
  assert.equal(record.channel, 'y');
  assert.equal(record.content, message);
  assert.equal(f.calls.insert, 1); assert.equal(f.calls.fallback, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.markers.y, 'utf8')), ['private-endpoint', message]);
  assert.equal(fs.existsSync(path.join(f.root, 'x-hook-started')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'y-hook-started')), false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
});

// Actual installed CLI copy + real private SQLite. Run when external send entry,
// declaration loading or pre-insert ordering changes; unrelated receive/history
// changes may skip it. Only fixture-owned node scripts can execute through PATH;
// no runtime, tmux, PM2, network or online DB is reachable. Sync child timeout
// reaps every invocation, and teardown closes SQLite and removes the fixture.
test('installed sender rejects invalid declarations with zero rows, heads and delivery', { timeout: 15000 }, t => {
  const f = setup(t, { installed: true });
  for (const [name, source] of malformed) {
    f.manifest(source);
    const result = f.invoke('x', ['--session-group', 'missing']);
    assert.ifError(result.error);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /HOOK_INVALID_OUTPUT/);
    const machine = JSON.parse(result.stdout);
    assert.equal(machine.ok, false); assert.equal(machine.error.code, 'HOOK_INVALID_OUTPUT');
    assert.equal(typeof machine.error.message, 'string');
    assert.doesNotMatch(result.stdout, /Message sent/);
    empty(f);
  }
  const missing = f.invoke('missing');
  assert.equal(missing.status, 1); assert.match(missing.stderr, /INVALID_ARGS/); empty(f);
  const y = f.invoke('y');
  assert.ifError(y.error); assert.equal(y.status, 0, y.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.markers.y, 'utf8')), ['private-endpoint', message]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
  assert.equal(f.db.prepare("SELECT channel FROM conversations").get().channel, 'y');
});


test('continue preserves original route and content, with Core IDs and stdin-only input before writing', async t => {
  const f = setup(t);
  const captured = path.join(f.root, 'hook-input.json');
  hook(f, `import fs from 'node:fs'; let input=''; for await (const chunk of process.stdin) input+=chunk;
    fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({input:JSON.parse(input),argv:process.argv.slice(2),cwd:process.cwd(),environment:process.env.SEND_HOOK_SENTINEL}));
    ${output({ version: 1, decision: 'continue' })}`);
  f.env.ZYLOS_SESSION_GROUP = 'origin';
  f.env.ZYLOS_RUN_ID = 'sender-run';
  f.env.ZYLOS_MODEL_CONFIG = JSON.stringify({ runtime: 'codex', mode: 'default' });
  f.env.CODEX_SESSION_ID = 'sender-codex';
  f.env.CLAUDE_SESSION_ID = 'other-runtime-session';
  f.env.SEND_HOOK_SENTINEL = 'unchanged';
  const ids = new Set();
  for (let index = 0; index < 2; index++) {
    const request = { channel: 'x', endpoint: 'original-endpoint', groupName: 'not-created',
      hook_id: 'forged-hook', request_id: 'forged-request', invocation_id: 'forged-invocation', context: { component: 'y' } };
    const originalInsert = f.api.insertConversation;
    f.api.insertConversation = (...args) => {
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, index);
      if (index === 0) {
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM group_heads').get().n, 0);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 0);
      }
      return originalInsert(...args);
    };
    const record = await sendExternal(request, message, f.options);
    f.api.insertConversation = originalInsert;
    const capture = JSON.parse(fs.readFileSync(captured, 'utf8'));
    assert.deepEqual(Object.keys(capture.input).sort(), ['context', 'hook_event_name', 'hook_id', 'invocation_id', 'request', 'request_id', 'version']);
    assert.equal(capture.input.version, 1);
    assert.equal(capture.input.hook_event_name, 'BeforeSend');
    assert.equal(capture.input.hook_id, 'check-send');
    for (const key of ['request_id', 'invocation_id']) {
      assert.match(capture.input[key], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(ids.has(capture.input[key]), false);
      ids.add(capture.input[key]);
    }
    assert.deepEqual(capture.input.request, { channel: 'x', endpoint: 'original-endpoint', content: message, options: { groupName: 'not-created' } });
    assert.deepEqual(capture.input.context, { component: 'x', session_group: 'origin', run_id: 'sender-run', runtime: 'codex', session_id: 'sender-codex' });
    assert.deepEqual(capture.argv, []);
    assert.equal(capture.cwd, fs.realpathSync(f.x));
    assert.equal(capture.environment, 'unchanged');
    assert.equal(record.channel, 'x'); assert.equal(record.endpoint_id, 'original-endpoint'); assert.equal(record.content, message);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.markers.x, 'utf8')), ['original-endpoint', message]);
  }
  assert.equal(f.calls.insert, 2); assert.equal(f.calls.fallback, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'y-hook-started')), false);
});

test('unavailable context identifiers are omitted without constructing a group', async t => {
  const f = setup(t), captured = path.join(f.root, 'hook-input.json');
  for (const key of ['ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete f.env[key];
  hook(f, `import fs from 'node:fs'; let input=''; for await (const chunk of process.stdin) input+=chunk;
    fs.writeFileSync(${JSON.stringify(captured)},input); ${output({ version: 1, decision: 'abort', message: 'stop' })}`);
  await assert.rejects(sendExternal({ channel: 'x', endpoint: null, wholeGroup: true }, message, f.options), { code: 'HOOK_ABORTED', message: 'stop' });
  const input = JSON.parse(fs.readFileSync(captured, 'utf8'));
  assert.deepEqual(input.context, { component: 'x' });
  assert.deepEqual(input.request, { channel: 'x', endpoint: null, content: message, options: { wholeGroup: true } });
  noSendSideEffects(f);
});

const badOutput = [
  ['non JSON', 'not JSON'],
  ['nonobject', '[]'],
  ['unknown version', JSON.stringify({ version: 2, decision: 'continue' })],
  ['unknown decision', JSON.stringify({ version: 1, decision: 'wait' })],
  ['continue message', JSON.stringify({ version: 1, decision: 'continue', message: 'extra' })],
  ['abort missing message', JSON.stringify({ version: 1, decision: 'abort' })],
  ['abort nonstring message', JSON.stringify({ version: 1, decision: 'abort', message: 1 })],
  ['content rewrite', JSON.stringify({ version: 1, decision: 'continue', content: 'rewritten' })],
  ['request rewrite', JSON.stringify({ version: 1, decision: 'continue', request: { channel: 'y' } })],
  ['extra field', JSON.stringify({ version: 1, decision: 'continue', extra: true })]
];
for (const [name, stdout] of badOutput) {
  test(`invalid hook output rejects ${name} before the original send path`, async t => {
    const f = setup(t); hook(f, `process.stdout.write(${JSON.stringify(stdout)});`);
    await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'HOOK_INVALID_OUTPUT' });
    noSendSideEffects(f);
  });
}

for (const [name, source, timeout, code] of [
  ['nonzero after continue', `${output({ version: 1, decision: 'continue' })} process.exitCode=7;`, 500, 'HOOK_EXEC_FAILED'],
  ['nonzero after abort', `${output({ version: 1, decision: 'abort', message: 'do not report abort' })} process.exitCode=7;`, 500, 'HOOK_EXEC_FAILED'],
  ['signal after continue', `${output({ version: 1, decision: 'continue' })} process.kill(process.pid,'SIGTERM');`, 500, 'HOOK_EXEC_FAILED'],
  ['timeout after abort', `${output({ version: 1, decision: 'abort', message: 'do not report abort' })} setInterval(()=>{},1000);`, 100, 'HOOK_TIMEOUT']
]) {
  test(`hook ${name} keeps every original send effect at zero`, async t => {
    const f = setup(t); hook(f, source, timeout);
    await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code });
    noSendSideEffects(f);
  });
}

test('hook spawn failure keeps routing and persistence at zero', async t => {
  const f = setup(t); hook(f, output({ version: 1, decision: 'continue' }));
  fs.renameSync(path.join(f.env.PATH, 'node'), path.join(f.env.PATH, 'node.saved'));
  await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'HOOK_EXEC_FAILED' });
  noSendSideEffects(f);
});

test('continue retains the original sender failure and its committed audit', async t => {
  const f = setup(t); hook(f, output({ version: 1, decision: 'continue' }));
  fs.writeFileSync(path.join(f.x, 'scripts', 'send.js'), 'process.exitCode=7;');
  await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'SEND_FAILED', exitCode: 7 });
  assert.equal(f.calls.insert, 1); assert.equal(f.calls.fallback, 1);
  const row = f.db.prepare('SELECT * FROM conversations').get();
  assert.equal(row.channel, 'x'); assert.equal(row.content, message); assert.equal(row.status, 'delivered');
});

// Real installed command and private SQLite, with the same isolation and
// lifecycle boundary as the installed-declaration case above. Run when hook
// wire/error formatting or the pre-insert gate changes; skip unrelated history.
test('installed abort reports the normalized single line and machine result without any send effects', { timeout: 5000 }, t => {
  const f = setup(t, { installed: true });
  const raw = 'rejected\n\r\u2028\u2029' + '😀'.repeat(510);
  const normalized = Array.from(raw.replace(/[\r\n\u2028\u2029]/g, ' ')).slice(0, 500).join('');
  hook(f, output({ version: 1, decision: 'abort', message: raw }));
  for (const args of [['x', 'private-endpoint', '--stdin', '--session-group', 'missing'], ['x', 'private-endpoint', message]]) {
    const result = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.root, env: f.env, input: `${message}\n`, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.equal(result.stderr, `HOOK_ABORTED ${normalized}\n`);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'HOOK_ABORTED', message: normalized } });
    noSendSideEffects(f);
  }
});

// The installed dispatcher selects these Core-owned paths before external
// declaration loading. Private Store seeds only the receiver group; malformed
// SKILL files must not intercept either operation. Same isolated child boundary.
test('installed internal and void paths ignore component hook declarations', { timeout: 5000 }, t => {
  const f = setup(t, { installed: true });
  for (const channel of ['internal', 'void']) {
    const directory = path.join(f.skillsDir, channel);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nc4: [broken\n---\n');
  }
  f.api.insertConversation('in', 'y', 'room', 'seed', { groupName: 'room' });
  for (const args of [['internal', 'y:room'], ['void', 'handoff', '--stdin']]) {
    const result = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.root, env: f.env, input: 'body\n', encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE channel='internal'").get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE channel='void'").get().n, 1);
});

// End-to-end boundary classification, beyond the process helper: an exact-size
// valid output must pass JSON parsing and send, while stderr is always drained.
test('valid exact-limit stdout and oversized stderr preserve the original send', async t => {
  for (const source of [
    `process.stdout.write(JSON.stringify({version:1,decision:'continue'}).padEnd(1024*1024,' '));`,
    `process.stderr.write('e'.repeat(1024*1024+1)); process.stdout.write(JSON.stringify({version:1,decision:'continue'}));`
  ]) {
    const f = setup(t); hook(f, source, 1500);
    const record = await sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options);
    assert.equal(record.channel, 'x'); assert.equal(record.content, message);
    assert.equal(f.calls.insert, 1); assert.equal(f.calls.fallback, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.markers.x, 'utf8')), ['private-endpoint', message]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
  }
});

test('stdout one byte over the limit rejects valid JSON before original send effects', async t => {
  const f = setup(t);
  hook(f, `process.stdout.write(JSON.stringify({version:1,decision:'continue'}).padEnd(1024*1024+1,' '));`, 1500);
  await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'HOOK_INVALID_OUTPUT' });
  noSendSideEffects(f);
});


// These declaration failures use real sendExternal/SQLite; run when manifest
// reading changes, skip unrelated process/transport edits. No process may start.
test('an unreadable SKILL directory rejects before hook, routing or persistence', async t => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.x, 'SKILL.md'));
  await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'HOOK_INVALID_OUTPUT' });
  empty(f);
});

test('a valid BOM and CRLF declaration actually executes its hook', async t => {
  const f = setup(t), marker = path.join(f.root, 'x-hook-started');
  hook(f, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'checked'); ${output({ version: 1, decision: 'abort', message: 'checked BOM declaration' })}`);
  f.manifest('\uFEFF' + frontmatter({ before_send: { ...validHook, timeout_ms: 500 } }).replace(/\n/g, '\r\n'));
  await assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'HOOK_ABORTED', message: 'checked BOM declaration' });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'checked');
  noSendSideEffects(f);
});

// Actual hook process groups and private Store. Run for lifecycle/stream changes;
// skip unrelated manifest or UI changes. The fixture independently records and
// kills every owned group/PID within 2s, even if product cleanup regresses; the
// send promise settles before SQLite teardown. Infinite output is rate-bounded
// to avoid unbounded memory use while testing an output-cap regression.
test('a normal hook leader with an unref stdout descendant continues without timeout', { timeout: 5000 }, async t => {
  const f = setup(t);
  const file = supervisedHook(f, `import { spawn } from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','ignore']});
    processRecord.pids.push(child.pid); writeRecord(recordFile,JSON.stringify(processRecord));
    child.unref(); ${output({ version: 1, decision: 'continue' })}`, 10000);
  const record = await boundedHook(f, sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options));
  assert.equal(record.content, message);
  assert.equal(f.calls.insert, 1); assert.equal(f.calls.fallback, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.markers.x, 'utf8')), ['private-endpoint', message]);
  const childPid = JSON.parse(fs.readFileSync(file, 'utf8')).pids[0];
  for (let i = 0; i < 50 && processAlive(childPid); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(processAlive(childPid), false, 'Inherited-stdout descendant must be stopped');
});

test('an endless stdout stream fails quickly at the cap before original send effects', { timeout: 5000 }, async t => {
  const f = setup(t);
  supervisedHook(f, `const chunk='x'.repeat(65536); setInterval(()=>process.stdout.write(chunk),5);`, 10000);
  const started = performance.now();
  await boundedHook(f, assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, message, f.options), { code: 'HOOK_INVALID_OUTPUT' }));
  assert.ok(performance.now() - started < 2000, 'Output cap must fail before the long declaration timeout');
  noSendSideEffects(f);
});

test('a hook that ignores a large stdin body can abort without an execution error', { timeout: 5000 }, async t => {
  const f = setup(t);
  supervisedHook(f, output({ version: 1, decision: 'abort', message: 'content too large' }), 10000);
  const large = 'x'.repeat(2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(large) > 65536);
  await boundedHook(f, assert.rejects(sendExternal({ channel: 'x', endpoint: 'private-endpoint' }, large, f.options), { code: 'HOOK_ABORTED', message: 'content too large' }));
  noSendSideEffects(f);
});
