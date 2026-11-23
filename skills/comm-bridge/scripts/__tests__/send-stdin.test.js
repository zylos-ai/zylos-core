import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const spawnFault = new URL('./fixtures/send-spawn-fault.js', import.meta.url).href;
const packageRoot = path.resolve(scripts, '../../..');

// Real installed CLI + private SQLite + fixture-owned receiver. Required for
// external transport/declaration changes; unrelated receive/history/UI may skip.
// HOME, DB, PM2, TMPDIR and tmux socket directory are private. PATH exposes only
// Node, so no runtime, PM2 or tmux can start. Every CLI has a synchronous timeout;
// teardown closes SQLite and removes only this fixture's resources.
function setup(t, { stdin = true, source } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-stdin-'));
  let db;
  t.after(() => { db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const skillsDir = path.join(zylos, '.claude', 'skills');
  const tmp = path.join(root, 'tmp'), bin = path.join(root, 'bin');
  for (const dir of [skillsDir, tmp, bin, path.join(zylos, '.zylos'), path.join(zylos, 'comm-bridge')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(zylos, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, PATH: bin, ZYLOS_PACKAGE_ROOT: packageRoot,
    SEND_TRANSPORT_SENTINEL: 'fixture-only' };
  for (const key of Object.keys(env)) {
    if (key === 'TMUX' || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/.test(key) ||
        ['ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)) delete env[key];
  }
  const filename = path.join(zylos, 'comm-bridge', 'c4.db');
  db = new Database(filename);
  guardDatabase(db, schema);
  const installed = path.join(skillsDir, 'comm-bridge');
  fs.mkdirSync(installed);
  fs.copyFileSync(path.join(scripts, '..', 'package.json'), path.join(installed, 'package.json'));
  fs.copyFileSync(path.join(scripts, '..', 'init-db.sql'), path.join(installed, 'init-db.sql'));
  fs.cpSync(scripts, path.join(installed, 'scripts'), { recursive: true,
    filter: file => !file.split(path.sep).includes('__tests__') });
  fs.symlinkSync(fs.realpathSync(path.join(scripts, '..', 'node_modules')), path.join(installed, 'node_modules'));
  const channel = path.join(skillsDir, 'example');
  fs.mkdirSync(path.join(channel, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(channel, 'package.json'), '{"type":"module"}');
  if (stdin) fs.writeFileSync(path.join(channel, 'SKILL.md'), '---\nname: example\nc4:\n  delivery: stdin\n---\n');
  const capture = path.join(root, 'received.json');
  fs.writeFileSync(path.join(channel, 'scripts', 'send.js'), source ?? `import fs from 'node:fs';
    ${stdin ? "let body=''; for await (const chunk of process.stdin) body+=chunk; const packet=JSON.parse(body);" : 'const packet=null;'}
    fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({packet,argv:process.argv.slice(2),sentinel:process.env.SEND_TRANSPORT_SENTINEL}));`);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(env[key].startsWith(`${root}${path.sep}`), key);
  }
  assert.equal(path.dirname(filename), path.join(env.ZYLOS_DIR, 'comm-bridge'));
  assert.deepEqual(fs.readdirSync(bin), ['node']);
  console.log('Transport isolation:', JSON.stringify({ ...Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH'].map(key => [key, env[key]])), db: filename }));
  return { db, env, root, capture, bin, skillsDir, invoke: (content, endpoint = 'private-endpoint', { fault } = {}) => spawnSync(process.execPath,
    [...(fault ? ['--import', spawnFault] : []), path.join(installed, 'scripts', 'c4-send.js'), 'example', ...(endpoint === null ? [] : [endpoint]), '--stdin'],
    { cwd: root, env: { ...env, ...(fault ? { C4_TEST_SPAWN_TARGET: path.join(channel, 'scripts', 'send.js'),
      C4_TEST_SPAWN_FAULT: fault } : {}) }, input: content, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }) };
}

function retained(f, count = 1, action = null) {
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, count);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations WHERE status=? AND delivery_action IS ?')
    .get(action ? 'failed' : 'delivered', action).n, count);
}

test('stdin delivery preserves Unicode, quotes and a body too large for argv', { timeout: 10000 }, t => {
  const f = setup(t);
  const content = `中文 😀 'quotes' "double" $literal\n${'long '.repeat(40000)}end`;
  const result = f.invoke(content + '\n');
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const { packet, argv, sentinel } = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  const row = f.db.prepare('SELECT * FROM conversations').get();
  assert.deepEqual(packet, { version: 1, c4_id: row.id, channel: row.channel,
    endpoint_id: row.endpoint_id, session_group: row.session_group, content });
  assert.deepEqual(argv, []); assert.equal(sentinel, 'fixture-only');
  assert.equal(row.content, content);
  retained(f);
});
