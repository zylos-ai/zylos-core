import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { acceptDelivery } from '../src/lib/chat/channel.js';
import { runSend } from '../scripts/send.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatChangeObserver } from '../src/lib/chat/change-observer.js';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

const gate = { skip: !chatEnabled(), timeout: 15000 };
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const group = 'dash:one';
const id = 'g:' + Buffer.from(group).toString('hex').toUpperCase();
function fixture(t, { displayName = null, committed = true } = {}) {
  const sandbox = createChatSandbox(t);
  sandbox.assertIsolation();
  const core = sandbox.openDatabase(sandbox.paths.c4Db, file => {
    const db = new Database(file); guardDatabase(db, schema); return db;
  });
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, file => new Store(file));
  const conversations = new ChatConversations({ store, idGenerator: () => 'one' });
  conversations.create({ displayName }); conversations.bind('one', 'dash');
  if (committed) conversations.markCommitted('one', { id: 1 });
  core.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash', 'dashboard');
  core.prepare('INSERT INTO group_heads VALUES (?,?)').run(group, 1);
  core.prepare(`INSERT INTO conversations(id,direction,channel,endpoint_id,session_group,content,status)
    VALUES(1,'in','dashboard','one',?,'帮我规划旅行','delivered')`).run(group);
  const skills = path.join(sandbox.paths.zylos, '.claude/skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(path.join(repo, 'skills/comm-bridge'), path.join(skills, 'comm-bridge'));
  fs.symlinkSync(path.join(repo, 'skills/dashboard'), path.join(skills, 'dashboard'));
  fs.mkdirSync(path.join(sandbox.paths.zylos, '.zylos'));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  const out = (changes = {}) => {
    const row = { id: core.prepare('SELECT COALESCE(MAX(id),0)+1 AS id FROM conversations').get().id,
      direction: 'out', channel: 'dashboard', endpoint_id: 'one', session_group: group,
      content: '好的，我们来规划旅行。', ...changes };
    core.prepare(`INSERT INTO conversations(id,direction,channel,endpoint_id,session_group,content,status)
      VALUES(@id,@direction,@channel,@endpoint_id,@session_group,@content,'delivered')`).run(row);
    return row;
  };
  const send = row => acceptDelivery({ version: 1, c4_id: row.id, channel: row.channel,
    endpoint_id: row.endpoint_id, session_group: row.session_group, content: row.content }, { env: sandbox.env });
  const count = () => core.prepare('SELECT COUNT(*) AS n FROM control_queue').get().n;
  return { sandbox, core, store, conversations, out, send, count };
}

// Integration boundary: real channel, SQLite ownership/name store and real C4
// enqueue subprocess. Run after naming/channel/control changes; skip UI-only work.
// The gated sandbox proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket
// and both database paths before opening/spawning, then owns all resource cleanup.
test('first committed Agent reply queues one control for its own group and later replies do not', gate, t => {
  const f = fixture(t);
  const first = f.out(); f.send(first);
  assert.equal(f.count(), 1);
  const control = f.core.prepare('SELECT * FROM control_queue').get();
  assert.equal(control.session_group, group);
  assert.ok(control.ack_deadline_at > Math.floor(Date.now() / 1000));
  assert.match(control.raw_content, /20 字以内/);
  assert.match(control.raw_content, /conversation-name\.js/);
  assert.match(control.raw_content, /不要在对话里回复用户/);
  f.send(first); assert.equal(f.count(), 1, 'repeated channel delivery cannot duplicate work');
  f.send(f.out()); assert.equal(f.count(), 1, 'second reply never rechecks eligibility');
  assert.equal(f.core.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 3, 'control is absent from history');
});

// Real naming transaction and private SQLite, with the enqueue boundary failing.
// Run on naming submission/fallback changes; skip unrelated UI work. The sandbox
// proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket/DBs and owns cleanup.
test('an enqueue failure names the conversation unknown without queuing or retrying later replies', gate, async t => {
  const f = fixture(t);
  const { requestConversationName } = await import('../src/lib/chat/auto-name.js');
  let attempts = 0;
  const enqueue = () => { attempts++; throw new Error('fixture enqueue failure'); };
  assert.equal(requestConversationName(f.out(), { env: f.sandbox.env, enqueue }), null);
  assert.equal(f.conversations.get('one').displayName, 'unknown');
  assert.equal(f.count(), 0);
  assert.equal(attempts, 1);
  assert.equal(requestConversationName(f.out(), { env: f.sandbox.env, enqueue }), null);
  assert.equal(f.conversations.get('one').displayName, 'unknown');
  assert.equal(f.count(), 0);
  assert.equal(attempts, 1, 'later replies never retry the failed naming submission');
});

// Same real channel/SQLite boundary and isolation as above. Run on first-reply
// eligibility/name changes; unrelated UI rendering can skip.
test('a name set before the first reply prevents naming even when later cleared', gate, t => {
  const f = fixture(t, { displayName: '用户名称' });
  f.send(f.out()); assert.equal(f.count(), 0);
  f.store.writeGroupDisplayName(group, null, 'human', { clear: true });
  f.send(f.out()); assert.equal(f.count(), 0);
});

// Same channel/SQLite eligibility boundary; run on naming changes, skip UI-only.
test('a manual rename after creation but before the first reply prevents enqueue', gate, t => {
  const f = fixture(t); f.conversations.rename('one', '提前命名');
  f.send(f.out()); assert.equal(f.count(), 0);
});

// Same real channel/SQLite boundary. Run on registration/receipt timing changes;
// unrelated UI work can skip. A reply may beat the browser's send receipt.
test('the first reply can name a bound conversation before its send receipt is reconciled', gate, t => {
  const f = fixture(t, { committed: false });
  f.send(f.out()); assert.equal(f.count(), 1);
});

// Same bound-receipt/name authority boundary. Run for trigger/name changes;
// unrelated UI rendering can skip. Workbench owns an already-set group name.
test('an existing Workbench name also wins before the browser reconciles a send receipt', gate, t => {
  const f = fixture(t, { committed: false });
  f.store.writeGroupDisplayName(group, '工作台名称', 'human');
  f.send(f.out()); assert.equal(f.count(), 0);
});

// Real reply qualification/history, using production naming and channel modules.
// Run for reply eligibility changes; skip rendering-only work. Same private DBs.
test('controls and other groups do not consume this conversation first reply', gate, async t => {
  const f = fixture(t);
  const { requestConversationName } = await import('../src/lib/chat/auto-name.js');
  const control = f.out({ content: '[C4-JSON]\n' + JSON.stringify({ version: 1, kind: 'control',
    messageId: 'control_stop', fallbackText: 'Stop question', interruptId: 'interrupt_single_question',
    control: { operation: 'stop', messageId: 'single_question' } }) });
  assert.equal(requestConversationName(control, { env: f.sandbox.env }), null);
  f.send(f.out({ endpoint_id: 'other', session_group: 'dash:other' }));
  assert.equal(f.count(), 0);
  f.send(f.out()); assert.equal(f.count(), 1);
});

// Real system notice producer -> C4 send -> channel -> history, followed by the
// first genuine reply. Run on provenance/naming changes; skip unrelated UI work.
// Private child env, SQLite and short socket are proven by the same sandbox.
test('a Core system notice neither triggers naming nor consumes the first Agent reply', gate, async t => {
  const f = fixture(t);
  const child = f.sandbox.startChild(process.execPath,
    [path.join(repo, 'skills/dashboard/test/helpers/chat-naming-status-notice.js')]);
  const result = await child.completion;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.core.prepare("SELECT delivery_action FROM conversations WHERE direction='out'").get().delivery_action, 'system_notice');
  assert.equal(f.count(), 0);
  f.send(f.out()); assert.equal(f.count(), 1);
  f.send(f.out()); assert.equal(f.count(), 1);
});

// Real authoritative row and incompatible fixture-owned Dashboard DB, with the
// actual receiver. Run on naming/delivery error changes; skip UI-only work.
// No product source rewriting or live resources; the sandbox owns both databases.
test('a naming store failure logs once while the committed reply delivery succeeds without enqueue', gate, t => {
  const f = fixture(t), row = f.out();
  f.store.db.prepare('INSERT INTO schema_migrations(version) VALUES(999)').run();
  const log = t.mock.method(console, 'error', () => {});
  let output = '';
  const result = runSend({ env: f.sandbox.env,
    input: () => JSON.stringify({ version: 1, c4_id: row.id, channel: row.channel,
      endpoint_id: row.endpoint_id, session_group: row.session_group, content: row.content }),
    stderr: { write: text => { output += text; } } });
  assert.equal(result, 0);
  assert.equal(output, '');
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], /naming is unavailable; reply delivery succeeded/);
  assert.equal(f.count(), 0);
  assert.equal(f.conversations.get('one').displayName, null);
  assert.equal(f.core.prepare("SELECT COUNT(*) AS n FROM conversations WHERE direction='out'").get().n, 1);
});

// Real local CLI + SQLite, no network/model/tmux/PM2. Run on writeback/name changes;
// unrelated rendering can skip. The sandbox proves and cleans every path/child.
test('Agent CLI writes only an empty name and returns an explicit no-overwrite result', gate, async t => {
  const f = fixture(t);
  const script = path.join(repo, 'skills/dashboard/scripts/conversation-name.js');
  const run = name => f.sandbox.startChild(process.execPath, [script, group, name, '--json']).completion;
  const first = await run('旅行规划');
  assert.equal(first.code, 0, first.stderr); assert.equal(JSON.parse(first.stdout).code, 'NAME_WRITTEN');
  assert.equal(f.conversations.get('one').displayName, '旅行规划');
  const second = await run('不应覆盖');
  assert.equal(second.code, 2, second.stderr); assert.equal(JSON.parse(second.stdout).code, 'NAME_ALREADY_SET');
  f.conversations.rename('one', '用户名称');
  assert.equal((await run('unknown')).code, 2);
  assert.equal(f.conversations.get('one').displayName, '用户名称');
  assert.equal((await run('x'.repeat(41))).code, 1);
  assert.equal((await run('bad\nname')).code, 1);
});

// Real concurrent CLI processes with separate SQLite connections; run for atomic
// writeback changes, skip unrelated UI. Sandbox owns both bounded child lifecycles.
test('concurrent Agent writebacks atomically keep exactly one proposed name', gate, async t => {
  const f = fixture(t), script = path.join(repo, 'skills/dashboard/scripts/conversation-name.js');
  const children = ['名称甲', '名称乙'].map(name =>
    f.sandbox.startChild(process.execPath, [script, group, name, '--json']));
  const results = await Promise.all(children.map(child => child.completion));
  assert.equal(results.filter(row => row.code === 0).length, 1);
  assert.equal(results.filter(row => row.code === 2).length, 1);
  assert.ok(['名称甲', '名称乙'].includes(f.conversations.get('one').displayName));
});

// Real C4 enqueue and lifecycle rows + production reconciliation and name store.
// Run on naming/deadline changes; skip unrelated UI. Same proven private resources.
for (const status of ['failed', 'timeout', 'done', 'pending', 'running']) {
  test(`a ${status} naming control past its deadline falls back without replacing a user name`, gate, async t => {
    const f = fixture(t); f.send(f.out());
    f.core.prepare('UPDATE control_queue SET status=?,ack_deadline_at=?').run(status, Math.floor(Date.now() / 1000) - 1);
    const { reconcileConversationNames } = await import('../src/lib/chat/auto-name.js');
    const reader = new C4Reader(f.sandbox.paths.zylos); t.after(() => reader.close());
    assert.equal(reconcileConversationNames({ store: f.store, c4Reader: reader }), 1);
    assert.equal(f.conversations.get('one').displayName, 'unknown');
    f.conversations.rename('one', '用户名称');
    assert.equal(reconcileConversationNames({ store: f.store, c4Reader: reader }), 0);
    assert.equal(f.conversations.get('one').displayName, '用户名称');
  });
}

// Same production reconciliation boundary. Run on failure/deadline changes;
// unrelated UI work can skip. A terminal failure does not wait for its deadline.
test('failed controls fall back immediately while unexpired pending controls wait', gate, async t => {
  const f = fixture(t); f.send(f.out());
  const { reconcileConversationNames } = await import('../src/lib/chat/auto-name.js');
  const reader = new C4Reader(f.sandbox.paths.zylos); t.after(() => reader.close());
  assert.equal(reconcileConversationNames({ store: f.store, c4Reader: reader }), 0);
  assert.equal(f.conversations.get('one').displayName, null);
  f.core.prepare("UPDATE control_queue SET status='failed'").run();
  assert.equal(reconcileConversationNames({ store: f.store, c4Reader: reader }), 1);
  assert.equal(f.conversations.get('one').displayName, 'unknown');
});

// Real production reconciliation and private SQLite: already-named groups must
// stop in the read path. Run on cleanup/name changes; skip unrelated rendering.
for (const committed of [true, false]) {
  test(`failed naming controls with existing names never enter the write path for ${committed ? 'committed' : 'bound'} conversations`, gate, async t => {
    const f = fixture(t, { committed }); f.send(f.out());
    f.core.prepare("UPDATE control_queue SET status='failed'").run();
    f.store.writeGroupDisplayName(group, '用户名称', 'human');
    const { reconcileConversationNames } = await import('../src/lib/chat/auto-name.js');
    const reader = new C4Reader(f.sandbox.paths.zylos); t.after(() => reader.close());
    const write = t.mock.method(ChatConversations.prototype, 'renameIfEmpty', () => assert.fail('already-named cleanup entered write path'));
    assert.equal(reconcileConversationNames({ store: f.store, c4Reader: reader }), 0);
    assert.equal(write.mock.callCount(), 0);
    assert.equal(f.store.getGroupDisplayName(group).display_name, '用户名称');
  });
}

// Real independent SQLite connections and production SSE observer; no network.
// Run on naming/observer changes; skip unrelated rendering. Sandbox owns DBs/loop.
test('manual and external CLI names invalidate all open pages while unrelated writes stay silent', gate, async t => {
  const f = fixture(t); f.send(f.out());
  const reader = new C4Reader(f.sandbox.paths.zylos);
  const history = new ChatHistory({ c4Reader: reader, conversations: f.conversations });
  const observer = new ChatChangeObserver({ c4Reader: reader, history });
  t.after(() => { observer.close(); reader.close(); });
  const a = [], b = [];
  for (const target of [a, b]) observer.subscribe({ tab: 'mine', conversationId: id }, {
    validate: () => true, send: event => { assert.ok(target.length < 10); target.push(event); } });
  f.conversations.rename('one', '人工名称'); observer._sample();
  assert.equal(a.at(-1), 'chat_messages_changed'); assert.equal(b.at(-1), 'chat_messages_changed');
  const before = a.length;
  f.store.db.prepare("UPDATE chat_conversations SET updated_at=updated_at+1 WHERE local_id='one'").run();
  observer._sample(); assert.equal(a.length, before, 'a write that does not change names cannot broadcast');
  f.store.writeGroupDisplayName(group, null, 'human', { clear: true }); observer._sample();
  const result = await f.sandbox.startChild(process.execPath,
    [path.join(repo, 'skills/dashboard/scripts/conversation-name.js'), group, '自动名称', '--json']).completion;
  assert.equal(result.code, 0, result.stderr); observer._sample();
  assert.equal(a.length, before + 2); assert.equal(b.length, a.length);
  assert.equal(f.conversations.get('one').displayName, '自动名称');
});
