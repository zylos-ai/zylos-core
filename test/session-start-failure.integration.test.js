import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createTestEnvironment } from '../scripts/test-environment.js';

const environment = createTestEnvironment();
const { routerFixture } = await import('../skills/comm-bridge/scripts/__tests__/helpers/router-fixture.js');
after(() => environment.cleanup());

// Run for internal-send/failure settlement/router changes; skip unrelated UI.
// Official runner isolates TMPDIR; this file owns a further private
// HOME/ZYLOS_DIR/PM2_HOME before product imports and cleans it after the router.
// Only CLI and SQLite are real here; launch/scene are deterministic boundaries.
// No tmux or channel transport is contacted. Real runtime startup is a separate gate.
test('real internal send receives one terminal receipt and later work can deliver', { timeout: 10000 }, async t => {
  const root = process.env.ZYLOS_DIR;
  assert.ok(root && path.isAbsolute(root), 'runner must isolate ZYLOS_DIR');
  const outsideHome = path.relative(os.userInfo().homedir, fs.realpathSync(root));
  assert.ok(outsideHome.startsWith(`..${path.sep}`) || path.isAbsolute(outsideHome));
  assert.notEqual(process.env.HOME, os.userInfo().homedir);
  assert.equal(process.env.PM2_HOME, path.join(process.env.HOME, '.pm2'));
  assert.ok(process.env.TMPDIR && environment.root.startsWith(process.env.TMPDIR + path.sep),
    'private fixture must live beneath the runner temporary hierarchy');
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) {
    assert.ok(process.env[key].startsWith(environment.root + path.sep), `${key} must belong to this file`);
  }
  fs.mkdirSync(path.join(root, 'comm-bridge'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude/skills/chat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  const f = routerFixture(t, { initialClock: Date.now(), databaseFile: path.join(root, 'comm-bridge/c4.db') });
  const databasePath = f.sqlite.pragma('database_list').find(row => row.name === 'main').file;
  assert.equal(fs.realpathSync(databasePath), fs.realpathSync(path.join(root, 'comm-bridge/c4.db')));
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, databasePath }));
  f.put('origin');
  f.db.insertConversation('in', 'chat', 'sender-chat', 'seed', { groupName: 'sender', status: 'failed' });
  f.put('chat:sender');
  const env = { ...process.env, ZYLOS_SESSION_GROUP: 'chat:sender' };
  delete env.ZYLOS_RUN_ID;
  const sent = spawnSync(process.execPath, ['skills/comm-bridge/scripts/c4-send.js', 'internal', 'chat:target'], {
    cwd: process.cwd(), env, input: 'private original body with misleading sender', encoding: 'utf8', timeout: 3000,
  });
  assert.equal(sent.status, 0, sent.stderr);
  const original = f.sqlite.prepare("SELECT * FROM conversations WHERE direction='in' AND channel='internal' AND session_group='chat:target'").get();
  assert.ok(original);
  f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now() / 1000, original.id);
  let failing = true;
  const base = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...base(runtime), launch: async input => {
    if (failing && input.sessionGroup === 'chat:target') throw Object.assign(Error('private exception'), {
      code: 'LAUNCH_FAILED', cause: 'timeout', launchTiming: { new_session_ms: 10001, executor_init_ms: 0,
        exec_confirm_ms: 0, cleanup_ms: 0, total_ms: 10001, timeout_ms: 10000, last_phase: 'new_session' },
    });
    return base(runtime).launch(input);
  } });
  await f.create().initialize();
  await f.rounds(6);
  assert.equal(f.row(original.id).status, 'failed');
  assert.equal(f.row(original.id).retry_count, 2);
  const receiptRows = () => f.sqlite.prepare("SELECT * FROM conversations WHERE delivery_action='failure_receipt'").all();
  assert.equal(receiptRows().length, 1);
  const receipt = receiptRows()[0];
  assert.equal(receipt.session_group, 'chat:sender');
  assert.equal(receipt.status, 'delivered');
  assert.match(receipt.content, new RegExp(`消息 #${original.id}`));
  assert.match(receipt.content, /chat:target/);
  assert.doesNotMatch(receipt.content, /private original|private exception/);
  assert.equal(f.calls.some(call => call[0] === 'alert'), false);
  const timings = f.events.filter(event => event.event === 'session_launch_failed');
  assert.equal(timings.length, 2);
  assert.deepEqual(timings.map(event => event.attempt), [1, 2]);
  assert.ok(timings.every(event => event.conversation_id === original.id && event.run_id && event.cause === 'timeout'));
  failing = false;
  const fresh = f.db.insertConversation('in', 'chat', 'target-chat', 'new work', { groupName: 'target' });
  await f.rounds(5);
  assert.equal(f.row(fresh.id).status, 'delivered');
  assert.equal(receiptRows().length, 1);
  t.diagnostic(JSON.stringify({ originalId: original.id, retries: 2, receipts: 1, laterDelivered: fresh.id }));
});
