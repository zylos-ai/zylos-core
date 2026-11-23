import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
  t.after(() => {
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
  const calls = { insert: 0 };
  const api = { ...store, getDb: () => db,
    insertConversation: (...args) => { calls.insert++; return store.insertConversation(...args); } };
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'), TMPDIR: tmp, TMUX_TMPDIR: tmp,
    PATH: bin, ZYLOS_PACKAGE_ROOT: packageRoot };
  for (const key of Object.keys(env)) {
    if (key === 'TMUX' || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/.test(key) || ['ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)) delete env[key];
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
  return { root, x, y, db, api, calls, env, skillsDir, markers, cli,
    options: { api, skillsDir, env },
    manifest: source => fs.writeFileSync(path.join(x, 'SKILL.md'), source),
    invoke: (channel = 'x', args = []) => spawnSync(process.execPath, [cli, channel, 'private-endpoint', '--stdin', ...args], {
      cwd: root, env, input: `${message}\n`, encoding: 'utf8', timeout: 3000, maxBuffer: 65536
    }) };
}

function noSendSideEffects(f) {
  for (const table of tables) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  assert.equal(f.calls.insert, 0);
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
  f.api.insertConversation('in', 'x', 'original-endpoint', 'owner', { groupName: 'room' });
  f.calls.insert = 0;
  fs.writeFileSync(path.join(f.x, 'scripts', 'session-group.js'), `process.stdout.write(${JSON.stringify('room\n')})`);
  f.env.ZYLOS_SESSION_GROUP = 'x:room';
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
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, index + 1);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM group_heads').get().n, 1);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 1);
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
    assert.deepEqual(capture.input.request, { channel: 'x', endpoint: 'original-endpoint', content: message, options: { groupName: 'room', wholeGroup: false } });
    assert.deepEqual(capture.input.context, { component: 'x', session_group: 'x:room', run_id: 'sender-run', runtime: 'codex', session_id: 'sender-codex' });
    assert.deepEqual(capture.argv, []);
    assert.equal(capture.cwd, fs.realpathSync(f.x));
    assert.equal(capture.environment, 'unchanged');
    assert.equal(record.channel, 'x'); assert.equal(record.endpoint_id, 'original-endpoint'); assert.equal(record.content, message);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.markers.x, 'utf8')), ['original-endpoint', message]);
  }
  assert.equal(f.calls.insert, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'y-hook-started')), false);
});

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
