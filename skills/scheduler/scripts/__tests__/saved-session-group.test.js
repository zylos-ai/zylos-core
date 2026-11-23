import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import * as c4Schema from '../../../comm-bridge/scripts/c4-schema.js';
import { migrateDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-group-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['telegram', 'lark']) fs.mkdirSync(path.join(root, '.claude/skills', name), { recursive: true });
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  migrateDatabase(c4, c4Schema, { allowNew: true });
  const store = createStore(() => c4, { validateComponent: () => true });
  store.registerChannelNamespace('telegram', 'tg');
  const before = c4.prepare('SELECT * FROM channel_namespaces ORDER BY component_name').all();
  const run = (args, group) => {
    const env = { ...process.env, ZYLOS_DIR: root, TZ: 'UTC' }; delete env.ZYLOS_SESSION_GROUP;
    if (group !== undefined) env.ZYLOS_SESSION_GROUP = group;
    return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  };
  const read = () => { const db = new Database(path.join(root, 'scheduler/scheduler.db')); try { return db.prepare('SELECT * FROM tasks ORDER BY rowid').all(); } finally { db.close(); } };
  t.after(() => c4.close());
  return { root, c4, store, before, run, read };
}
const pair = task => [task.session_component, task.session_group_name];
const add = (f, args = [], group) => { const answer = f.run(['add', 'fixture', '--in', '1 hour', ...args], group); assert.equal(answer.status, 0, answer.stderr); return f.read().at(-1); };

test('actual add covers seven saved-target cases; no namespace allocation or requirement', t => {
  const f = fixture(t);
  assert.deepEqual(pair(add(f, [], 'tg:g-1')), ['telegram', 'g-1']);
  assert.deepEqual(pair(add(f, ['--reply-channel', 'telegram', '--reply-endpoint', '-1', '--reply-session-group', 'g-1'], 'tg:dm')), ['telegram', 'g-1']);
  assert.deepEqual(pair(add(f, ['--reply-channel', 'telegram', '--reply-endpoint', '-1'], 'tg:dm')), ['telegram', null]);
  assert.deepEqual(pair(add(f)), [null, null]);
  // Old task shape is still allowed to have a route and no saved target.
  const legacy = add(f); const db = new Database(path.join(f.root, 'scheduler/scheduler.db'));
  db.prepare("UPDATE tasks SET reply_channel='telegram',reply_endpoint='-9' WHERE id=?").run(legacy.id); db.close();
  assert.deepEqual(pair(f.read().at(-1)), [null, null]);
  assert.deepEqual(pair(add(f, ['--reply-channel', 'lark', '--reply-endpoint', 'chat-new', '--reply-session-group', 'g-new'])), ['lark', 'g-new']);
  assert.deepEqual(pair(add(f, ['--reply-channel', 'telegram', '--reply-endpoint', '-1001', '--reply-session-group', 'g-1001'], 'tg:dm-1')), ['telegram', 'g-1001']);
  assert.deepEqual(pair(add(f, [], 'origin')), [null, null]);
  assert.deepEqual(f.c4.prepare('SELECT * FROM channel_namespaces ORDER BY component_name').all(), f.before);
  assert.equal(f.c4.prepare('SELECT count(*) AS n FROM group_heads').get().n, 0);
});

test('update recomputes explicit target; clear and ordinary fields preserve saved values, including NULL', t => {
  const f = fixture(t);
  for (const initial of [[], ['--reply-channel', 'telegram', '--reply-endpoint', '-1', '--reply-session-group', 'g-old']]) {
    const task = add(f, initial);
    let answer = f.run(['update', task.id, '--priority', '1'], 'tg:editor'); assert.equal(answer.status, 0, answer.stderr);
    let row = f.read().find(row => row.id === task.id); assert.deepEqual(pair(row), pair(task));
    answer = f.run(['update', task.id, '--reply-channel', 'lark', '--reply-endpoint', 'new', '--reply-session-group', 'g-new'], 'tg:editor');
    assert.equal(answer.status, 0, answer.stderr); row = f.read().find(row => row.id === task.id); assert.deepEqual(pair(row), ['lark', 'g-new']);
    answer = f.run(['update', task.id, '--clear-reply'], 'tg:editor'); assert.equal(answer.status, 0, answer.stderr);
    row = f.read().find(row => row.id === task.id); assert.deepEqual(pair(row), ['lark', 'g-new']); assert.equal(row.reply_channel, null); assert.equal(row.reply_endpoint, null);
    answer = f.run(['update', task.id, '--reply-channel', 'telegram', '--reply-endpoint', '-1'], 'tg:editor'); assert.equal(answer.status, 0, answer.stderr);
    row = f.read().find(row => row.id === task.id); assert.deepEqual(pair(row), ['telegram', null]);
    answer = f.run(['update', task.id, '--reply-endpoint', '-2'], 'tg:editor'); assert.equal(answer.status, 0, answer.stderr);
    assert.deepEqual(pair(f.read().find(row => row.id === task.id)), ['telegram', null]);
  }
});

test('single mode ignores latest lark input and other-group tmux hints', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ session_mode: 'single' }));
  f.store.insertConversation('in', 'lark', 'other-chat', 'unrelated latest input', { groupName: 'other-group' });
  const beforeBindings = f.c4.prepare('SELECT * FROM channel_namespaces ORDER BY component_name').all();
  const beforeMessages = f.c4.prepare('SELECT * FROM conversations ORDER BY id').all();
  const run = group => {
    const env = { ...process.env, ZYLOS_DIR: f.root, TZ: 'UTC',
      TMUX: '/tmp/unrelated-session,1,0', TMUX_PANE: '%987' };
    delete env.ZYLOS_SESSION_GROUP;
    if (group !== undefined) env.ZYLOS_SESSION_GROUP = group;
    // The native CLI executes after all process-launch APIs become forbidden.
    // No real tmux command or service is touched by this fixture.
    const bootstrap = `import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      for (const name of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'])
        cp[name] = () => { throw new Error(' forbidden session probe'); };
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'add', 'interference', '--in', '1 hour'];
      await import(${JSON.stringify(new URL('../cli.js', import.meta.url).href)});`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], { env, encoding: 'utf8' });
  };
  for (const [group, expected] of [[undefined, [null, null]], ['origin', [null, null]], ['tg:creator', ['telegram', 'creator']]]) {
    const result = run(group); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(pair(f.read().at(-1)), expected);
  }
  assert.deepEqual(f.c4.prepare('SELECT * FROM channel_namespaces ORDER BY component_name').all(), beforeBindings);
  assert.deepEqual(f.c4.prepare('SELECT * FROM conversations ORDER BY id').all(), beforeMessages);
});
