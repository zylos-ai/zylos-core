import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from '../sqlite-driver.js';
import { createStore } from '../c4-v2-store.js';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { sendExternal } from '../c4-send-external.js';
import { formatConversation } from '../router/format.js';
import { formatConversationsForAgent } from '../c4-db.js';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.resolve(scripts, '../../..');
const body = 'A request with "quotes", $variables, `backticks` and\na second line';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(t, { installed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-session-'));
  const home = path.join(root, "home with ' quote");
  const zylos = path.join(home, 'zylos');
  const skillsDir = path.join(zylos, '.claude', 'skills');
  const bin = path.join(root, 'bin'), tmp = path.join(root, 'tmp');
  for (const dir of [bin, tmp, skillsDir, path.join(zylos, '.zylos'), path.join(zylos, 'comm-bridge')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(zylos, '.zylos', 'config.json'), '{"runtime":"claude","session_mode":"multi"}');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
  const env = { HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'), TMPDIR: tmp,
    TMUX_TMPDIR: tmp, PATH: bin, ZYLOS_PACKAGE_ROOT: packageRoot, ZYLOS_SESSION_GROUP: 'chat:a' };
  const hookMarker = path.join(root, 'hook.jsonl'), deliveryMarker = path.join(root, 'delivery.jsonl');
  const queryMarker = path.join(root, 'query.jsonl'), answer = path.join(root, 'query-answer');
  fs.writeFileSync(answer, 'a\n');
  function installComponent(name) {
    const component = path.join(skillsDir, name);
    fs.mkdirSync(path.join(component, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(component, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(component, 'scripts', 'before-send.js'),
      "import fs from 'node:fs'; let body=''; for await(const chunk of process.stdin) body+=chunk;\n" +
      'fs.appendFileSync(' + JSON.stringify(hookMarker) + ", body+'\\n');\n" +
      'process.stdout.write(\'{"version":1,"decision":"continue"}\');');
    fs.writeFileSync(path.join(component, 'SKILL.md'), '---\nc4:\n  before_send:\n    hook_id: outbound-check\n    entry: scripts/before-send.js\n    timeout_ms: 1000\n---\n');
    fs.writeFileSync(path.join(component, 'scripts', 'send.js'), "import fs from 'node:fs';\n" +
      'fs.appendFileSync(' + JSON.stringify(deliveryMarker) + ", JSON.stringify(process.argv.slice(2))+'\\n');");
    fs.writeFileSync(path.join(component, 'scripts', 'session-group.js'), "import fs from 'node:fs';\n" +
      'fs.appendFileSync(' + JSON.stringify(queryMarker) + ", JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),sender:process.env.ZYLOS_SESSION_GROUP})+'\\n');\n" +
      'process.stdout.write(fs.readFileSync(' + JSON.stringify(answer) + '));');
    return component;
  }
  const component = installComponent('chat');
  const databasePath = path.join(zylos, 'comm-bridge', 'c4.db');
  const db = new Database(databasePath);
  guardDatabase(db, schema); db.pragma('journal_mode=WAL');
  const store = createStore(db, { readSessionMode: () => ({ mode: 'multi' }), validateComponent: name => ['chat', 'dashboard'].includes(name) && fs.existsSync(path.join(skillsDir, name)) });
  const api = { ...store, getDb: () => db };
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const options = { api, skillsDir, env };
  const seed = (endpoint, groupName) => store.insertConversation('in', 'chat', endpoint, 'incoming', { groupName });
  const count = table => db.prepare('SELECT count(*) AS n FROM ' + table).get().n;
  const snapshot = ({ bindings = true } = {}) => JSON.stringify(Object.fromEntries(
    ['conversations', 'group_heads', ...(bindings ? ['channel_namespaces'] : []), 'control_queue']
      .map(table => [table, db.prepare('SELECT * FROM ' + table).all()])));
  const untouched = (before, snapshotOptions) => {
    assert.equal(snapshot(snapshotOptions), before);
    assert.equal(fs.existsSync(hookMarker), false);
    assert.equal(fs.existsSync(deliveryMarker), false);
    assert.equal(fs.existsSync(path.join(zylos, 'comm-bridge', 'receive-events.jsonl')), false);
  };
  const lines = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trimEnd().split('\n').map(JSON.parse) : [];
  let cli;
  if (installed) {
    const destination = path.join(skillsDir, 'comm-bridge');
    fs.mkdirSync(destination);
    for (const name of ['package.json', 'init-db.sql']) fs.copyFileSync(path.join(scripts, '..', name), path.join(destination, name));
    fs.cpSync(scripts, path.join(destination, 'scripts'), { recursive: true, filter: source => !source.split(path.sep).includes('__tests__') });
    fs.symlinkSync(fs.realpathSync(path.join(scripts, '..', 'node_modules')), path.join(destination, 'node_modules'));
    cli = path.join(destination, 'scripts', 'c4-send.js');
  }
  function isolatedEnv(sender = env.ZYLOS_SESSION_GROUP, extra = {}) {
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key].startsWith(root + path.sep), key);
    assert.ok(databasePath.startsWith(root + path.sep));
    assert.equal(fs.existsSync(path.join(bin, 'tmux')), false);
    assert.equal(fs.existsSync(path.join(bin, 'pm2')), false);
    console.log('Outbound child isolation:', JSON.stringify({ ...env, databasePath }));
    const childEnv = { ...env, ZYLOS_SESSION_GROUP: sender, ...extra };
    if (sender === undefined) delete childEnv.ZYLOS_SESSION_GROUP;
    return childEnv;
  }
  const invoke = (args, sender, content = body, extra) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env: isolatedEnv(sender, extra), input: content, encoding: 'utf8', timeout: 8000, maxBuffer: 65536,
  });
  return { root, env, skillsDir, component, db, store, api, seed, count, snapshot, untouched, options,
    hookMarker, deliveryMarker, queryMarker, cli, invoke, isolatedEnv, installComponent,
    queryGroup: group => fs.writeFileSync(answer, group), queries: () => lines(queryMarker),
    hooks: () => lines(hookMarker), deliveries: () => lines(deliveryMarker) };
}

function sent(f, row, group, endpoint = 'recipient') {
  assert.equal(row.session_group, group);
  assert.equal(row.direction, 'out');
  assert.equal(row.content, body);
  assert.equal(f.hooks().at(-1).request.content, body);
  assert.deepEqual(f.deliveries().at(-1), endpoint === null ? [body] : [endpoint, body]);
}

const request = { channel: 'chat', endpoint: 'recipient' };

test('component query controls routing despite conflicting inbound and outbound history', async t => {
  const f = fixture(t);
  f.seed('a-home', 'a'); f.seed('recipient', 'b');
  f.store.insertConversation('out', 'chat', 'recipient', 'old route', { groupName: 'b' });
  sent(f, await sendExternal(request, body, f.options), 'chat:a');
  assert.equal(f.queries().length, 1);
  assert.deepEqual(f.queries()[0], { args: ['recipient'], cwd: f.component, sender: 'chat:a' });
  assert.deepEqual(f.hooks()[0].request.options, { groupName: 'a', wholeGroup: false });
});

test('legacy group options cannot override the component answer or leak into the hook', async t => {
  const f = fixture(t); f.seed('a-home', 'a');
  sent(f, await sendExternal({ ...request, groupName: 'bad group', wholeGroup: true }, body, f.options), 'chat:a');
  assert.deepEqual(f.hooks()[0].request.options, { groupName: 'a', wholeGroup: false });
  f.queryGroup('b\n');
  const before = f.snapshot();
  await assert.rejects(sendExternal({ ...request, groupName: 'a' }, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.snapshot(), before);
  assert.equal(f.hooks().length, 1);
  assert.equal(f.deliveries().length, 1);
});

test('a present sender key must name origin or an existing group before querying', async t => {
  for (const sender of ['', 'chat:missing', 'bad group', null, 0]) {
    const f = fixture(t); f.env.ZYLOS_SESSION_GROUP = sender;
    const before = f.snapshot();
    await assert.rejects(sendExternal(request, body, f.options), { code: 'UNKNOWN_GROUP' });
    f.untouched(before);
    assert.equal(f.queries().length, 0);
  }
});

test('an absent sender key still queries and records under the current component answer', async t => {
  const f = fixture(t); delete f.env.ZYLOS_SESSION_GROUP; f.queryGroup('b\n');
  f.env.ZYLOS_RUN_ID = 'single-run';
  sent(f, await sendExternal(request, body, f.options), 'chat:b');
  assert.equal(f.queries().length, 1);
});

test('failed component queries stop before namespace allocation hooks storage or delivery', async t => {
  for (const source of ["process.stdout.write('invalid group');", 'process.exit(7);']) {
    const f = fixture(t);
    delete f.env.ZYLOS_SESSION_GROUP;
    fs.writeFileSync(path.join(f.component, 'scripts', 'session-group.js'), source);
    const before = f.snapshot();
    await assert.rejects(sendExternal(request, body, f.options), { code: 'SESSION_GROUP_QUERY_FAILED' });
    f.untouched(before);
    assert.equal(f.count('channel_namespaces'), 0);
  }
});

test('fresh cross-session refusal may allocate only its installed namespace binding', async t => {
  const f = fixture(t); f.env.ZYLOS_SESSION_GROUP = 'origin'; f.queryGroup('b\n');
  const before = f.snapshot({ bindings: false });
  await assert.rejects(sendExternal(request, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  f.untouched(before, { bindings: false });
  assert.equal(f.count('channel_namespaces'), 1);
  assert.equal(f.store.getChannelNamespace('chat').namespace, 'chat');
  assert.equal(f.count('group_heads'), 0);
});

test('existing binding cross-session refusal leaves all C4 rows unchanged', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('b\n');
  const before = f.snapshot();
  await assert.rejects(sendExternal(request, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  f.untouched(before);
  assert.equal(f.queries().length, 1);
});

test('missing query script, null endpoint and empty output each use the whole component', async t => {
  for (const mode of ['missing', 'null', 'empty']) {
    const f = fixture(t); f.seed('whole-home'); f.env.ZYLOS_SESSION_GROUP = 'chat';
    if (mode === 'missing') fs.unlinkSync(path.join(f.component, 'scripts', 'session-group.js'));
    if (mode === 'empty') f.queryGroup('\n');
    const endpoint = mode === 'null' ? null : 'recipient';
    sent(f, await sendExternal({ ...request, endpoint, groupName: 'ignored' }, body, f.options), 'chat', endpoint);
    assert.equal(f.queries().length, mode === 'empty' ? 1 : 0);
    assert.deepEqual(f.hooks()[0].request.options, { wholeGroup: true });
  }
});

test('component query runs once per send without caching and ignores a later inbound route', async t => {
  const f = fixture(t); f.seed('a-home', 'a');
  const api = { ...f.api, insertConversation: (...args) => {
    f.seed('recipient', 'b');
    return f.store.insertConversation(...args);
  } };
  sent(f, await sendExternal(request, body, { ...f.options, api }), 'chat:a');
  assert.equal(f.queries().length, 1);
  assert.deepEqual(f.hooks()[0].request.options, { groupName: 'a', wholeGroup: false });
  f.queryGroup('b\n'); f.env.ZYLOS_SESSION_GROUP = 'chat:b';
  sent(f, await sendExternal(request, body, f.options), 'chat:b');
  assert.equal(f.queries().length, 2);
  assert.deepEqual(f.hooks()[1].request.options, { groupName: 'b', wholeGroup: false });
});

test('Dashboard origin shares the fixed origin rule and bypasses its query', async t => {
  const f = fixture(t); f.installComponent('dashboard');
  f.env.ZYLOS_SESSION_GROUP = 'origin';
  const row = await sendExternal({ channel: 'dashboard', endpoint: 'origin' }, body, f.options);
  sent(f, row, 'origin', 'origin');
  assert.equal(f.queries().length, 0);
  assert.equal(f.count('channel_namespaces'), 0);
  assert.deepEqual(f.hooks()[0].request.options, { groupName: 'origin', wholeGroup: false });
  f.seed('a-home', 'a'); f.env.ZYLOS_SESSION_GROUP = 'chat:a';
  const before = f.snapshot();
  await assert.rejects(sendExternal({ channel: 'dashboard', endpoint: 'origin' }, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.snapshot(), before);
  assert.equal(f.queries().length, 0);
  assert.equal(f.hooks().length, 1);
  assert.equal(f.deliveries().length, 1);
});

// Same installed isolation boundary. Run for fixed-address or reply-via changes:
// the route an Origin session is given (live delivery and the session-start
// context) names no group, and replying with it records origin.
test('an owner message to dashboard origin offers a reply route without a group that records origin', { timeout: 10000 }, t => {
  const f = fixture(t, { installed: true }); f.installComponent('dashboard');
  const incoming = f.store.insertConversation('in', 'dashboard', 'origin', 'Are the alerts handled?');
  const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(incoming.id);
  assert.equal(row.session_group, 'origin');
  const options = { ownerName: () => 'the owner', lookupQuote: () => null };
  for (const text of [formatConversation(row, { ...options, scriptPath: f.cli }), formatConversationsForAgent([row], { ...options, spill: false })]) {
    // Live delivery quotes for the shell with single quotes, the session-start context with double quotes.
    const route = text.match(/---- reply via: node .+ (['"])([^'"]*)\1 (['"])([^'"]*)\3$/m);
    assert.ok(route, text);
    assert.doesNotMatch(text, /--session-group/);
    const [channel, endpoint] = [route[2], route[4]];
    assert.deepEqual([channel, endpoint], ['dashboard', 'origin']);
    const reply = f.invoke([channel, endpoint, '--stdin'], 'origin');
    assert.ifError(reply.error); assert.equal(reply.status, 0, reply.stderr);
    sent(f, f.db.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT 1').get(), 'origin', 'origin');
  }
  assert.equal(f.queries().length, 0);
  assert.equal(f.count('channel_namespaces'), 0);
});

function ordinaryMessage(script) {
  return 'this chat address belongs to session group "chat:b", not to this thread ("chat:a"). Nothing was sent or recorded.\n' +
    'Each address is handled by one thread. Ask that thread to deliver it: send an internal message saying what to deliver, to whom (channel and the address you used), and why.\n' +
    "cat <<'EOF_INTERNAL' | node " + quote(script) + " internal 'chat:b'\n" +
    'Please deliver to chat <address>: <text>. Why: <reason>.\n' +
    'EOF_INTERNAL\n' +
    'If "chat:b" has no thread yet, this message creates it.';
}

test('ordinary cross-session diagnostics have the finalized placeholders without endpoint or body', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('b\n');
  const endpoint = 'secret-address\nEOF_INTERNAL\n$(touch injected) `touch injected`';
  await assert.rejects(sendExternal({ ...request, endpoint }, body, f.options), error => {
    assert.equal(error.code, 'CROSS_SESSION_OUTBOUND');
    assert.equal(error.message, ordinaryMessage(path.join(scripts, 'c4-send.js')));
    assert.equal(error.message.includes(endpoint), false);
    assert.equal(error.message.includes(body), false);
    return true;
  });
});

test('absorbed cross-session diagnostics retain id and run command without the stored route', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('b\n');
  await assert.rejects(sendExternal({ ...request, endpoint: 'private-route', id: 37, runId: 'run-1' }, body, f.options), error => {
    assert.equal(error.code, 'CROSS_SESSION_OUTBOUND');
    assert.equal(error.message,
      'absorbed message 37 belongs to session group "chat:b", not to this thread ("chat:a"). Nothing was sent or recorded.\n' +
      'Ask that thread to reply: send an internal message with the reply text and this command for it to run.\n' +
      "cat <<'EOF_INTERNAL' | node " + quote(path.join(scripts, 'c4-send.js')) + " internal 'chat:b'\n" +
      'Please reply to absorbed message 37 with: <text>. Why: <reason>.\n' +
      'Command: c4-send.js --absorbed-reply run-1 37\n' +
      'EOF_INTERNAL');
    assert.equal(error.message.includes('private-route'), false);
    assert.equal(error.message.includes('chat address'), false);
    assert.equal(error.message.includes(body), false);
    return true;
  });
});

function relayCommand(stderr) {
  const lines = stderr.split('\n');
  const first = lines.findIndex(line => line.startsWith("cat <<'EOF_INTERNAL'"));
  const last = lines.findIndex((line, i) => i > first && line === 'EOF_INTERNAL');
  assert.ok(first >= 0 && last > first);
  return lines.slice(first, last + 1).join('\n');
}

// Real installed CLI and private SQLite with a fixture channel. Run for changes
// to ownership, diagnostics or internal handoffs; unrelated readers may skip.
// HOME, ZYLOS_DIR, PM2_HOME, TMPDIR and tmux directory are private and read back.
// PATH contains only node/cat, with no runtime, tmux, PM2, services or network.
// Child timeouts/output caps and fixture teardown bound and clean every resource.
test('installed CLI refusal relays from A into a new B group before B sends', { timeout: 20000 }, t => {
  const f = fixture(t, { installed: true }); f.seed('a-home', 'a'); f.queryGroup('b\n');
  assert.equal(f.db.prepare("SELECT 1 FROM group_heads WHERE session_group='chat:b'").get(), undefined);
  const before = f.snapshot();
  const denied = f.invoke(['chat', 'recipient', '--stdin']);
  assert.ifError(denied.error); assert.equal(denied.status, 1, denied.stderr);
  assert.equal(denied.stderr, '[C4] CROSS_SESSION_OUTBOUND: ' + ordinaryMessage(f.cli) + '\n');
  f.untouched(before);
  const command = relayCommand(denied.stderr);
  const relay = spawnSync('/bin/sh', ['-c', command], { cwd: f.root, env: f.isolatedEnv(),
    encoding: 'utf8', timeout: 8000, maxBuffer: 65536 });
  assert.ifError(relay.error); assert.equal(relay.status, 0, relay.stderr);
  const pair = f.db.prepare("SELECT * FROM conversations WHERE channel='internal' ORDER BY id").all();
  assert.equal(pair.length, 2);
  assert.deepEqual(pair.map(row => [row.direction, row.session_group, row.endpoint_id, row.status]), [
    ['out', 'chat:a', 'chat:b', 'delivered'], ['in', 'chat:b', 'chat:a', 'pending'],
  ]);
  assert.equal(pair[0].content, 'Please deliver to chat <address>: <text>. Why: <reason>.');
  assert.equal(pair[1].content, '[internal] Yourself, from your "chat:a" session group, said: ' + pair[0].content);
  for (const row of pair) assert.equal(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(row.session_group).head_id, row.id);
  assert.equal(f.hooks().length, 0); assert.equal(f.deliveries().length, 0);
  const delivered = f.invoke(['chat', 'recipient', '--stdin'], 'chat:b');
  assert.ifError(delivered.error); assert.equal(delivered.status, 0, delivered.stderr);
  const last = f.db.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT 1').get();
  sent(f, last, 'chat:b');
  assert.equal(last.endpoint_id, 'recipient'); assert.equal(last.status, 'delivered');
  assert.equal(f.count('conversations'), 4);
  assert.equal(f.queries().length, 2);
  assert.equal(f.db.prepare("SELECT head_id FROM group_heads WHERE session_group='chat:b'").get().head_id, last.id);
});

// Same installed isolation boundary. Run for sender-environment changes; this
// proves the CLI with a run identity alone remains outside the session check.
test('installed pre-migration CLI with only a run identity uses the queried group', { timeout: 10000 }, t => {
  const f = fixture(t, { installed: true }); f.queryGroup('b\n');
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos', 'config.json'), '{"runtime":"claude"}');
  delete f.env.ZYLOS_SESSION_GROUP; f.env.ZYLOS_RUN_ID = 'single-run';
  const result = f.invoke(['chat', 'recipient', '--stdin']);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.includes('WARNING'), false);
  sent(f, f.db.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT 1').get(), 'chat:b');
  assert.equal(f.count('conversations'), 1);
});

// Same installed isolation boundary. Run for relay formatting changes; an
// endpoint containing shell bytes must never enter the displayed command.
test('installed relay command excludes endpoint shell and heredoc control bytes', { timeout: 10000 }, t => {
  const f = fixture(t, { installed: true }); f.seed('a-home', 'a'); f.queryGroup('b\n');
  const endpoint = 'room\nEOF_INTERNAL\n$(touch injected) `touch injected` \'"';
  const denied = f.invoke(['chat', endpoint, '--stdin']);
  assert.ifError(denied.error); assert.equal(denied.status, 1, denied.stderr);
  assert.equal(denied.stderr.includes(endpoint), false);
  const relay = spawnSync('/bin/sh', ['-c', relayCommand(denied.stderr)], { cwd: f.root, env: f.isolatedEnv(),
    encoding: 'utf8', timeout: 8000, maxBuffer: 65536 });
  assert.ifError(relay.error); assert.equal(relay.status, 0, relay.stderr);
  assert.equal(f.db.prepare("SELECT content FROM conversations WHERE channel='internal' AND direction='out'").get().content,
    'Please deliver to chat <address>: <text>. Why: <reason>.');
  assert.equal(fs.existsSync(path.join(f.root, 'injected')), false);
  assert.equal(f.hooks().length, 0); assert.equal(f.deliveries().length, 0);
});

const singleMode = () => ({ mode: 'single', keyPresent: true });
const multiMode = () => ({ mode: 'multi', keyPresent: true });
const outbound = f => f.db.prepare("SELECT * FROM conversations WHERE direction='out' ORDER BY id DESC LIMIT 1").get();

test('native single records Origin and session-less sends under origin without the cross-session check', async t => {
  for (const sender of ['origin', undefined]) {
    const f = fixture(t); f.queryGroup('b\n');
    if (sender === undefined) delete f.env.ZYLOS_SESSION_GROUP; else f.env.ZYLOS_SESSION_GROUP = sender;
    // No binding exists yet: the send allocates it in the write transaction instead of refusing.
    sent(f, await sendExternal(request, body, { ...f.options, readSessionMode: singleMode }), 'origin');
    assert.deepEqual(f.hooks()[0].request.options, { groupName: 'b', wholeGroup: false });
    assert.equal(f.store.getChannelNamespace('chat').namespace, 'chat');
    assert.equal(f.db.prepare("SELECT head_id FROM group_heads WHERE session_group='origin'").get().head_id, outbound(f).id);
    assert.equal(f.db.prepare("SELECT 1 FROM group_heads WHERE session_group='chat:b'").get(), undefined);
  }
});

test('native single still refuses a failed component query before any write', async t => {
  const f = fixture(t); f.env.ZYLOS_SESSION_GROUP = 'origin';
  fs.writeFileSync(path.join(f.component, 'scripts', 'session-group.js'), 'process.exit(3);');
  const before = f.snapshot();
  await assert.rejects(sendExternal(request, body, { ...f.options, readSessionMode: singleMode }), { code: 'SESSION_GROUP_QUERY_FAILED' });
  f.untouched(before);
});

test('a group sender in native single still records its own group', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('a\n');
  sent(f, await sendExternal(request, body, { ...f.options, readSessionMode: singleMode }), 'chat:a');
});

test('a pre-migration mode keeps the current rules for Origin and session-less senders', async t => {
  const readSessionMode = () => ({ mode: null, keyPresent: false });
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('b\n'); f.env.ZYLOS_SESSION_GROUP = 'origin';
  await assert.rejects(sendExternal(request, body, { ...f.options, readSessionMode }), { code: 'CROSS_SESSION_OUTBOUND' });
  delete f.env.ZYLOS_SESSION_GROUP;
  sent(f, await sendExternal(request, body, { ...f.options, readSessionMode }), 'chat:b');
});

// Installed CLI with a real config.json in an isolated ZYLOS_DIR. Run for changes
// to how c4-send reads session_mode; it never starts tmux or PM2.
test('installed CLI treats an unreadable mode as multi and warns on one line', { timeout: 20000 }, t => {
  const f = fixture(t, { installed: true }); f.seed('a-home', 'a'); f.queryGroup('a\n');
  const dashboard = f.installComponent('dashboard');
  fs.rmSync(path.join(dashboard, 'scripts', 'session-group.js'));
  const config = path.join(f.env.ZYLOS_DIR, '.zylos', 'config.json');
  fs.writeFileSync(config, '{broken');
  const before = f.snapshot();
  const denied = f.invoke(['chat', 'recipient', '--stdin'], 'origin');
  assert.equal(denied.status, 1); assert.match(denied.stderr, /CROSS_SESSION_OUTBOUND/);
  assert.equal(denied.stderr.split('\n').filter(line => line.startsWith('[C4] WARNING: cannot read session_mode')).length, 1);
  assert.equal(f.snapshot(), before);
  delete f.env.ZYLOS_SESSION_GROUP;
  const sessionless = f.invoke(['chat', 'recipient', '--stdin']);
  assert.equal(sessionless.status, 0, sessionless.stderr);
  assert.equal(sessionless.stderr.split('\n').filter(line => line.startsWith('[C4] WARNING')).length, 1);
  sent(f, outbound(f), 'chat:a');
  const member = f.invoke(['chat', 'recipient', '--stdin'], 'chat:a');
  assert.equal(member.status, 0, member.stderr); assert.equal(member.stderr.includes('WARNING'), false);
  // Origin can still answer its own Dashboard address while the mode is unreadable.
  const own = f.invoke(['dashboard', 'origin', '--stdin'], 'origin');
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stderr, /WARNING: cannot read session_mode/);
  const row = outbound(f);
  assert.deepEqual([row.channel, row.endpoint_id, row.session_group], ['dashboard', 'origin', 'origin']);
  fs.writeFileSync(config, '{"runtime":"claude","session_mode":"single"}');
  const single = f.invoke(['chat', 'recipient', '--stdin'], 'origin');
  assert.equal(single.status, 0, single.stderr); assert.equal(single.stderr.includes('WARNING'), false);
  sent(f, outbound(f), 'origin');
});

function switchedBack(f, { target = 'multi', updatedAt = Math.floor(Date.now() / 1000) - 60 } = {}) {
  f.db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES(?,?,?,'complete',?,?)")
    .run(`run-${target}-${updatedAt}`, target === 'multi' ? 'single' : 'multi', target, updatedAt - 1, updatedAt);
  return updatedAt;
}
// An inbound row that was delivered to Origin in single mode keeps its address and is recorded under origin.
function deliveredToOrigin(f, endpoint, groupName = 'a') {
  const row = f.seed(endpoint, groupName);
  f.db.prepare("UPDATE conversations SET session_group='origin',status='delivered' WHERE id=?").run(row.id);
  return row;
}

test('after switching back to multi the crossing Origin run may answer its exact single-mode address', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('a\n'); f.env.ZYLOS_SESSION_GROUP = 'origin';
  const options = { ...f.options, readSessionMode: multiMode };
  deliveredToOrigin(f, 'chat-a|msg:7');
  switchedBack(f);
  sent(f, await sendExternal({ channel: 'chat', endpoint: 'chat-a|msg:7' }, body, options), 'origin', 'chat-a|msg:7');
  assert.deepEqual(f.hooks()[0].request.options, { groupName: 'a', wholeGroup: false });
  const before = f.snapshot();
  // Another message id in the same chat was never delivered to Origin.
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'chat-a|msg:8' }, body, options), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.snapshot(), before);
});

test('the Origin reply exception closes when any Origin run ends after the switch', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('a\n'); f.env.ZYLOS_SESSION_GROUP = 'origin';
  const options = { ...f.options, readSessionMode: multiMode };
  const reply = { channel: 'chat', endpoint: 'chat-a|msg:7' };
  deliveredToOrigin(f, reply.endpoint);
  const switched = switchedBack(f);
  // An ending before the switch belongs to an earlier run: the run that crossed it is still open.
  f.db.prepare("INSERT INTO run_endings(session_group,run_id,reason,ended_at,continuation_pending) VALUES('origin','run-old','ttl',?,0)").run(switched - 5);
  sent(f, await sendExternal(reply, body, options), 'origin', reply.endpoint);
  f.db.prepare("UPDATE run_endings SET run_id='run-crossing',ended_at=? WHERE session_group='origin'").run(switched + 30);
  const before = f.snapshot();
  await assert.rejects(sendExternal(reply, body, options), { code: 'CROSS_SESSION_OUTBOUND' });
  // An ending in the same second as the switch is not earlier than it.
  f.db.prepare("UPDATE run_endings SET ended_at=? WHERE session_group='origin'").run(switched);
  await assert.rejects(sendExternal(reply, body, options), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.snapshot(), before);
});

test('the Origin reply exception needs a completed switch whose target is multi', async t => {
  for (const latest of ['single', 'open']) {
    const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('a\n'); f.env.ZYLOS_SESSION_GROUP = 'origin';
    deliveredToOrigin(f, 'chat-a|msg:7');
    if (latest === 'single') { switchedBack(f, { updatedAt: 1000 }); switchedBack(f, { target: 'single', updatedAt: 2000 }); }
    if (latest === 'open') f.db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('open','single','multi','gating',1,1)").run();
    const before = f.snapshot();
    await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'chat-a|msg:7' }, body, { ...f.options, readSessionMode: multiMode }),
      { code: 'CROSS_SESSION_OUTBOUND' }, latest);
    assert.equal(f.snapshot(), before);
  }
});

test('the Origin reply exception is only for Origin and only for inbound rows recorded under origin', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('a\n');
  f.seed('chat-a|msg:9', 'a');
  f.store.insertConversation('out', 'chat', 'chat-a|msg:9', 'old reply', { groupName: 'a', recordGroup: 'origin' });
  switchedBack(f);
  f.env.ZYLOS_SESSION_GROUP = 'origin';
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'chat-a|msg:9' }, body, { ...f.options, readSessionMode: multiMode }), { code: 'CROSS_SESSION_OUTBOUND' });
  deliveredToOrigin(f, 'chat-b|msg:1', 'b');
  f.env.ZYLOS_SESSION_GROUP = 'chat:a';
  f.queryGroup('b\n');
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'chat-b|msg:1' }, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
});

test('a host can send for an address under its own history until detached', async t => {
  const f = fixture(t);
  f.seed('recipient', 'a');
  f.seed('host-home', 'b');
  f.seed('unrelated-home', 'd');
  f.store.attachSessionHost('chat:a', 'chat:b', 'chat:b');
  f.env.ZYLOS_SESSION_GROUP = 'chat:b';
  sent(f, await sendExternal(request, body, f.options), 'chat:b');
  f.env.ZYLOS_SESSION_GROUP = 'chat:a';
  sent(f, await sendExternal(request, body, f.options), 'chat:a');
  f.env.ZYLOS_SESSION_GROUP = 'chat:d';
  await assert.rejects(sendExternal(request, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.store.detachSessionHost('chat:a'), true);
  f.env.ZYLOS_SESSION_GROUP = 'chat:b';
  await assert.rejects(sendExternal(request, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.deliveries().length, 2);
  assert.equal(f.count('conversations'), 5);
});
