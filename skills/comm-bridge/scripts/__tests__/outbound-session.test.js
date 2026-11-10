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

const scripts = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.resolve(scripts, '../../..');
const body = 'A request with "quotes", $variables, `backticks` and\na second line';

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
  const component = path.join(skillsDir, 'chat');
  fs.mkdirSync(path.join(component, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(component, 'package.json'), '{"type":"module"}');
  const hookMarker = path.join(root, 'hook.jsonl'), deliveryMarker = path.join(root, 'delivery.jsonl');
  const hookScript = path.join(component, 'scripts', 'before-send.js');
  const hookSource = `import fs from 'node:fs'; let body=''; for await(const chunk of process.stdin) body+=chunk;
    fs.appendFileSync(${JSON.stringify(hookMarker)}, body+'\\n');
    process.stdout.write('{"version":1,"decision":"continue"}');`;
  fs.writeFileSync(hookScript, hookSource);
  fs.writeFileSync(path.join(component, 'SKILL.md'), `---\nc4:\n  before_send:\n    hook_id: outbound-check\n    entry: scripts/before-send.js\n    timeout_ms: 1000\n---\n`);
  fs.writeFileSync(path.join(component, 'scripts', 'send.js'), `import fs from 'node:fs';
    fs.appendFileSync(${JSON.stringify(deliveryMarker)}, JSON.stringify(process.argv.slice(2))+'\\n');`);
  const databasePath = path.join(zylos, 'comm-bridge', 'c4.db');
  const db = new Database(databasePath);
  guardDatabase(db, schema); db.pragma('journal_mode=WAL');
  const store = createStore(db, { validateComponent: name => name === 'chat' });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let fallback = 0;
  const options = { api: store, skillsDir, env, appendFallback: async () => { fallback++; } };
  const seed = (endpoint, groupName) => store.insertConversation('in', 'chat', endpoint, 'incoming', { groupName });
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const snapshot = () => JSON.stringify(Object.fromEntries(['conversations', 'group_heads', 'channel_namespaces', 'control_queue'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])));
  const untouched = before => {
    assert.equal(snapshot(), before);
    assert.equal(fs.existsSync(hookMarker), false);
    assert.equal(fs.existsSync(deliveryMarker), false);
    assert.equal(fallback, 0);
    assert.equal(fs.existsSync(path.join(zylos, 'comm-bridge', 'receive-events.jsonl')), false);
  };
  let cli;
  if (installed) {
    const destination = path.join(skillsDir, 'comm-bridge');
    fs.mkdirSync(destination);
    for (const name of ['package.json', 'init-db.sql']) fs.copyFileSync(path.join(scripts, '..', name), path.join(destination, name));
    fs.cpSync(scripts, path.join(destination, 'scripts'), { recursive: true, filter: source => !source.split(path.sep).includes('__tests__') });
    fs.symlinkSync(fs.realpathSync(path.join(scripts, '..', 'node_modules')), path.join(destination, 'node_modules'));
    cli = path.join(destination, 'scripts', 'c4-send.js');
  }
  const invoke = (args, sender = env.ZYLOS_SESSION_GROUP, content = body, extra = {}) => {
    const childEnv = { ...env, ZYLOS_SESSION_GROUP: sender, ...extra };
    if (sender === undefined) delete childEnv.ZYLOS_SESSION_GROUP;
    return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: childEnv, input: content, encoding: 'utf8', timeout: 4000, maxBuffer: 65536 });
  };
  return { root, env, skillsDir, db, store, seed, count, snapshot, untouched, options, hookMarker, deliveryMarker,
    hookScript, hookSource, cli, invoke, databasePath };
}

function sent(f, row, group) {
  assert.equal(row.session_group, group);
  assert.equal(row.direction, 'out'); assert.equal(row.content, body);
  assert.equal(JSON.parse(fs.readFileSync(f.hookMarker, 'utf8').trim()).request.content, body);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.deliveryMarker, 'utf8').trim()), ['recipient', body]);
}

test('same-session replies use the latest inbound route despite later outbound history', async t => {
  const f = fixture(t);
  f.seed('recipient', 'b'); f.seed('recipient', 'a');
  f.store.insertConversation('out', 'chat', 'recipient', 'older routing', { groupName: 'b' });
  sent(f, await sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), 'chat:a');
  assert.equal(f.count('conversations'), 4);
});

test('cross-session rejection has no C4, fallback, hook or delivery effects', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.seed('recipient', 'b');
  const before = f.snapshot();
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), error => {
    assert.equal(error.code, 'CROSS_SESSION_OUTBOUND');
    assert.match(error.message, /session chat:b/); assert.match(error.message, /sender session chat:a/);
    assert.match(error.message, /c4-send\.js' internal 'chat:b'/);
    assert.match(error.message, /EOF_INTERNAL/);
    assert.equal(error.message.includes(body), false);
    return true;
  });
  f.untouched(before);
});

test('namespace inbound ownership is checked even without a local subgroup', async t => {
  const f = fixture(t); f.seed('recipient');
  const before = f.snapshot();
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  f.untouched(before);
  f.env.ZYLOS_SESSION_GROUP = 'chat';
  sent(f, await sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), 'chat');
});

test('a process without either session identity keeps external sending available', async t => {
  const f = fixture(t); f.seed('recipient', 'b'); delete f.env.ZYLOS_SESSION_GROUP;
  sent(f, await sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), 'chat:b');
});

test('new recipients remain unowned even if other recipients have used the namespace', async t => {
  const f = fixture(t); f.seed('unrelated');
  sent(f, await sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), 'chat');
});

test('preview of a fresh channel does not register its namespace before a hook rejects', async t => {
  const f = fixture(t); const before = f.snapshot();
  fs.writeFileSync(f.hookScript, `process.stdout.write('{"version":1,"decision":"abort","message":"fixture refusal"}');`);
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), { code: 'HOOK_ABORTED' });
  f.untouched(before);
});

test('origin, including a run-only identity, must relay to other sessions', async t => {
  for (const env of [{ ZYLOS_SESSION_GROUP: 'origin' }, { ZYLOS_RUN_ID: 'origin-run' }]) {
    const f = fixture(t); f.seed('recipient', 'b');
    delete f.env.ZYLOS_SESSION_GROUP; Object.assign(f.env, env);
    const before = f.snapshot();
    await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
    f.untouched(before);
  }
});

test('origin is allowed to use its own system route', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => f.store.checkOutboundSession('system', null, {}, 'origin'));
  assert.throws(() => f.store.checkOutboundSession('system', null, {}, 'chat:a'), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.count('channel_namespaces'), 0);
});

test('explicit existing subgroup takes precedence and owns even a new recipient', async t => {
  const f = fixture(t); f.seed('recipient', 'b'); f.seed('a-home', 'a');
  sent(f, await sendExternal({ channel: 'chat', endpoint: 'recipient', groupName: 'a' }, body, f.options), 'chat:a');
  const g = fixture(t); g.seed('b-home', 'b'); const before = g.snapshot();
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'recipient', groupName: 'b' }, body, g.options), { code: 'CROSS_SESSION_OUTBOUND' });
  g.untouched(before);
});

test('unknown explicit subgroups and whole-group routes use the shared namespace fallback', async t => {
  for (const route of [{ groupName: 'missing' }, { groupName: 'bad name' }, { groupName: 'x'.repeat(96) }, { wholeGroup: true }]) {
    const f = fixture(t); f.seed('recipient', 'b'); const before = f.snapshot();
    await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'recipient', ...route }, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
    f.untouched(before);
    f.env.ZYLOS_SESSION_GROUP = 'chat';
    sent(f, await sendExternal({ channel: 'chat', endpoint: 'recipient', ...route }, body, f.options), 'chat');
    const g = fixture(t);
    sent(g, await sendExternal({ channel: 'chat', endpoint: 'recipient', ...route }, body, g.options), 'chat');
  }
});

test('a changed owner during BeforeSend is rejected by the actual insert transaction', async t => {
  const f = fixture(t); f.seed('recipient', 'a'); f.seed('b-home', 'b');
  const insert = f.store.insertConversation;
  // Simulate an inbound committed after the async hook, before the actual write.
  const api = { ...f.store, insertConversation: (...args) => {
    f.seed('recipient', 'b');
    return insert(...args);
  } };
  await assert.rejects(sendExternal({ channel: 'chat', endpoint: 'recipient' }, body, { ...f.options, api }), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(f.count('conversations'), 3);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE direction='out'").get().n, 0);
  assert.equal(fs.existsSync(f.hookMarker), true);
  assert.equal(fs.existsSync(f.deliveryMarker), false);
});

// Real installed CLI + private SQLite + fixture channel: run for changes to
// outbound ownership, error commands or internal handoffs; unrelated readers may
// skip. HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and tmux directory are private; PATH has
// only node/cat, no tmux/PM2/runtime. No service or network is used. Each child is
// synchronous with a timeout and bounded output; teardown closes DB and removes
// every installed copy, marker and temporary path.
test('installed CLI rejection command relays from A to B before B sends externally', { timeout: 20000 }, t => {
  const f = fixture(t, { installed: true }); f.seed('a-home', 'a'); f.seed('recipient', 'b');
  for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(f.env[name].startsWith(`${f.root}${path.sep}`), name);
  }
  assert.ok(f.databasePath.startsWith(`${f.root}${path.sep}`));
  assert.equal(fs.existsSync(path.join(f.env.PATH, 'tmux')), false);
  console.log('Outbound isolation:', JSON.stringify({ ...f.env, databasePath: f.databasePath }));
  const before = f.snapshot();
  const denied = f.invoke(['chat', 'recipient', '--stdin']);
  assert.ifError(denied.error); assert.equal(denied.status, 1, denied.stderr);
  assert.match(denied.stderr, /CROSS_SESSION_OUTBOUND.*session chat:b/);
  f.untouched(before);
  const command = denied.stderr.slice(denied.stderr.indexOf("cat <<'EOF_INTERNAL'"));
  assert.match(command, /c4-send\.js.*internal 'chat:b'/);
  const relay = spawnSync('/bin/sh', ['-c', command], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 4000, maxBuffer: 65536 });
  assert.ifError(relay.error); assert.equal(relay.status, 0, relay.stderr);
  const pair = f.db.prepare("SELECT * FROM conversations WHERE channel='internal' ORDER BY id").all();
  assert.equal(pair.length, 2);
  assert.deepEqual(pair.map(row => [row.direction, row.session_group, row.endpoint_id, row.status]), [
    ['out', 'chat:a', 'chat:b', 'delivered'], ['in', 'chat:b', 'chat:a', 'pending'],
  ]);
  assert.match(pair[0].content, /Please relay/);
  assert.equal(pair[1].content, `[internal] Yourself, from your "chat:a" session group, said: ${pair[0].content}`);
  for (const row of pair) assert.equal(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(row.session_group).head_id, row.id);
  assert.equal(fs.existsSync(f.hookMarker), false); assert.equal(fs.existsSync(f.deliveryMarker), false);
  const delivered = f.invoke(['chat', 'recipient', '--stdin'], 'chat:b');
  assert.ifError(delivered.error); assert.equal(delivered.status, 0, delivered.stderr);
  const last = f.db.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT 1').get();
  sent(f, last, 'chat:b');
  assert.equal(last.endpoint_id, 'recipient'); assert.equal(last.status, 'delivered');
  assert.equal(f.count('conversations'), 5);
  assert.equal(f.db.prepare("SELECT head_id FROM group_heads WHERE session_group='chat:b'").get().head_id, last.id);
});

// Same isolation/cleanup boundary as above. Run when inferred Origin or the
// copyable command changes; proves the exact command works without group env.
test('installed run-only origin can execute the suggested internal command', { timeout: 10000 }, t => {
  const f = fixture(t, { installed: true }); f.seed('recipient', 'b');
  delete f.env.ZYLOS_SESSION_GROUP; f.env.ZYLOS_RUN_ID = 'origin-run';
  const before = f.snapshot();
  const denied = f.invoke(['chat', 'recipient', '--stdin'], undefined, body, { ZYLOS_RUN_ID: 'origin-run' });
  assert.ifError(denied.error); assert.equal(denied.status, 1, denied.stderr);
  assert.match(denied.stderr, /sender session origin/); f.untouched(before);
  const command = denied.stderr.slice(denied.stderr.indexOf("cat <<'EOF_INTERNAL'"));
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 4000, maxBuffer: 65536 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const pair = f.db.prepare("SELECT direction,session_group,endpoint_id FROM conversations WHERE channel='internal' ORDER BY id").all();
  assert.deepEqual(pair, [
    { direction: 'out', session_group: 'origin', endpoint_id: 'chat:b' },
    { direction: 'in', session_group: 'chat:b', endpoint_id: 'origin' },
  ]);
});
