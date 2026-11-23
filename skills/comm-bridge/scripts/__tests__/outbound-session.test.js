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

test('existing binding cross-session refusal leaves all C4 rows unchanged', async t => {
  const f = fixture(t); f.seed('a-home', 'a'); f.queryGroup('b\n');
  const before = f.snapshot();
  await assert.rejects(sendExternal(request, body, f.options), { code: 'CROSS_SESSION_OUTBOUND' });
  f.untouched(before);
  assert.equal(f.queries().length, 1);
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

const singleMode = () => ({ mode: 'single', keyPresent: true });
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

// An inbound row that was delivered to Origin in single mode keeps its address and is recorded under origin.

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
