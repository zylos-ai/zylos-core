import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { AuthGate } from '../src/lib/auth.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatActivity, SETTLE_MS, stepLabel, subtaskKey } from '../src/lib/chat/activity.js';
import { handleChatHistory } from '../src/lib/chat/history-routes.js';
import { workingHistory } from '../src/lib/workbench/working.js';
import { sendJson } from '../src/lib/http.js';
import { migrateDatabase, TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { CELL_A_LINES, CELL_B_LINES, CELL_C_LINES, CELL_D_LINES, V1_CHILD, cellEndingAs, cellPolledInNewExec, rebase,
  v1ChildRollout, v1ParentTurn, v2CompletedTurn, v2InterruptedTurn } from './fixtures/codex-multi-agent-rollout.js';

const GROUP = 'dash-owned:a';
const ID = `g:${Buffer.from(GROUP).toString('hex').toUpperCase()}`;
const T0 = Date.parse('2026-11-08T10:00:00.000Z');
const at = seconds => T0 + seconds * 1000;
const c4 = seconds => new Date(at(seconds)).toISOString().replace('T', ' ').slice(0, 19);
const TTL = 30 * 60_000;

// Temporary c4 and dashboard SQLite files only; no runtime, Core or outside network. The header's reading of the group
// comes from the real working reducer over the same events, as the Dashboard's workbench snapshot computes it.
function fixture(t, { now = at(600), presence = 'running', tools = 0 } = {}) {
  assert.ok(process.env.ZYLOS_DIR && process.env.ZYLOS_DIR !== '/home/agent/zylos');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-activity-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  migrateSchema(db, { isNew: true });
  migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash-owned', 'dashboard');
  const store = new Store(path.join(root, 'dashboard.db'));
  const reader = new C4Reader(root);
  const history = new ChatHistory({ c4Reader: reader });
  const clock = { now, presence, tools };
  const working = async group => {
    if (clock.presence !== 'running') return { working: null, presence: clock.presence, ttlMs: TTL };
    const events = store.db.prepare('SELECT event_seq, timestamp, event_type, metadata FROM runtime_events WHERE session_group=? AND timestamp<=?')
      .all(group, new Date(clock.now).toISOString()).map(row => ({ ...row, metadata: JSON.parse(row.metadata) }));
    return { working: workingHistory(events, clock.now, { ttlMs: TTL, tools: clock.tools }).working, presence: 'running', ttlMs: TTL };
  };
  const activity = new ChatActivity({ history, store, working, now: () => clock.now });
  const insert = db.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,session_group,content,status,delivery_action)
    VALUES (@id,@timestamp,@direction,@channel,@endpoint_id,@session_group,@content,@status,NULL)`);
  const message = (id, seconds, direction = 'in', extra = {}) => insert.run({ id, timestamp: c4(seconds), direction,
    channel: 'dashboard', endpoint_id: 'a', session_group: GROUP, content: `message ${id}`, status: 'delivered', ...extra });
  const event = (type, seconds, fields = {}) => store.insertEvent({ id: crypto.randomUUID(), ingest_id: crypto.randomUUID(),
    timestamp: new Date(at(seconds)).toISOString(), runtime: fields.runtime ?? 'claude', session_id: fields.session ?? 's1',
    session_group: fields.group ?? GROUP, run_id: 'r1', event_type: type, category: 'test', summary: fields.summary ?? null,
    metadata: fields.meta ?? {}, source: 'test' });
  const deliver = (id, seconds, meta = {}) => event('deliver', seconds, { meta: { conversation_id: id, ...meta }, session: null });
  const tool = (useId, start, end, meta = {}, outcome = 'post_tool_use') => {
    event('pre_tool_use', start, { meta: { tool_use_id: useId, ...meta } });
    if (end !== null) event(outcome, end, { meta: { tool_use_id: useId, ...meta } });
  };
  // A C4 control row as the router leaves it: `done` once delivered, at that second.
  const control = (id, status, seconds) => db.prepare(`INSERT INTO control_queue (id,raw_content,content,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run(id, '[KEYSTROKE]Escape', '[KEYSTROKE]Escape', status, Math.floor(at(seconds) / 1000), Math.floor(at(seconds) / 1000));
  const bulk = work => store.db.transaction(work)();
  t.after(() => { reader.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, store, history, activity, message, event, deliver, tool, clock, control, bulk };
}
const read = (f, options = {}) => f.activity.activity(ID, { tab: 'mine', ...options });
const shown = result => result.steps.map(step => step.kind === 'say' ? `say:${step.text}`
  : step.kind === 'mark' ? `mark:${step.mark}${step.label ? `:${step.label.key}${step.label.arg ? `:${step.label.arg}` : ''}` : ''}`
    : `${step.label.key}:${step.label.arg ?? ''}:${step.status}`);

test('a first message in a new session: from sending, through the start-up turn, to the work taken from the queue', async t => {
  const f = fixture(t, { now: at(0.5), presence: 'stopped' });
  f.message(1, 0, 'in', { status: 'pending' });
  let result = await read(f);
  assert.equal(result.working, null); assert.equal(result.presence, 'stopped');
  assert.deepEqual(result.awaiting, { id: 1, state: 'queued', since: at(0) }, 'waiting for the session to wake');
  assert.equal(result.seenId, 1);
  // The session wakes and runs its start-up turn; the message is delivered while it runs and queued inside the runtime.
  f.clock.presence = 'running';
  f.event('user_prompt_submit', 2); f.tool('boot', 2.5, 3, { tool_name: 'Read', tool_detail: 'memory/state.md' });
  f.db.prepare("UPDATE conversations SET status='delivered' WHERE id=1").run();
  f.deliver(1, 4);
  f.event('stop', 6);
  f.clock.now = at(7);
  result = await read(f);
  assert.equal(result.awaiting.state, 'thinking', 'delivered: being thought about');
  assert.equal(result.awaiting.delivered, at(4));
  assert.deepEqual(result.steps, [], 'the start-up turn ended with the group quiet; its steps are not this work');
  assert.equal(result.from, at(6));
  assert.equal(result.working.on, false, 'the start-up turn stopped');
  // The runtime takes the message from its queue with no event of its own; only its tools show.
  f.tool('one', 8, 9, { tool_name: 'Read', tool_detail: 'a.md' });
  f.tool('two', 10, null, { tool_name: 'Bash', tool_detail: 'Check disk space', detail_source: 'description' });
  f.clock.now = at(11);
  result = await read(f);
  assert.equal(result.working.on, true, 'the header works as soon as the main agent acts');
  assert.equal(result.working.main.since, at(8));
  assert.deepEqual(shown(result), ['read:a.md:done', 'described:Check disk space:running']);
  assert.equal(result.awaiting.state, 'thinking');
});

test('steps carry plain labels only and never a summarized command line', async t => {
  const f = fixture(t, { now: at(20) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('read', 1, 2, { tool_name: 'Read', tool_detail: 'memory/state.md' });
  f.tool('raw', 3, 4, { tool_name: 'Bash', tool_detail: 'df -h /secret/path', detail_source: 'command' });
  f.tool('bad', 5, 6, { tool_name: 'Read', tool_detail: 'b' }, 'post_tool_failure');
  f.event('assistant_message', 7, { summary: 'Found  it.' });
  f.tool('mcp', 8, null, { tool_name: 'mcp__secret__tool', tool_detail: 'raw input' });
  const result = await read(f);
  assert.deepEqual(shown(result), ['read:memory/state.md:done', 'runCommand::done', 'read:b:failed', 'say:Found it.', 'tool::running']);
  const text = JSON.stringify(result);
  for (const secret of ['df -h', 'mcp__secret', 'raw input']) assert.ok(!text.includes(secret), secret);
  assert.equal(result.steps[0].end - result.steps[0].start, 1000);
});

test('labels never fall back to tool names or raw input', () => {
  const label = (meta, runtime = 'claude', summary = null) => stepLabel({ meta, runtime, summary });
  assert.deepEqual(label({ tool_name: 'WebSearch', tool_detail: '"backup lock"' }), { key: 'search', arg: '"backup lock"' });
  assert.deepEqual(label({ tool_name: 'WebFetch', tool_detail: 'example.com/a' }), { key: 'open', arg: 'example.com/a' });
  assert.deepEqual(label({ tool_name: 'Skill', tool_detail: 'comm-bridge' }), { key: 'skill', arg: 'comm-bridge' });
  assert.deepEqual(label({ tool_name: 'Write', tool_detail: 'a.md' }), { key: 'write', arg: 'a.md' });
  assert.deepEqual(label({ tool_name: 'mcp__secret__tool', tool_detail: 'raw' }), { key: 'tool' });
  assert.deepEqual(label({ tool_name: 'Bash', tool_detail: 'cat /etc/x' }), { key: 'runCommand' });
  assert.deepEqual(label({ tool_name: 'view_image' }, 'codex'), { key: 'tool' });
  assert.deepEqual(label({ tool_name: 'apply_patch' }, 'codex', 'Edit files: a, b'), { key: 'editFiles' });
});

test('a message sent mid-work is a mark among the steps, which stay', async t => {
  const f = fixture(t, { now: at(12) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('a', 1, 2, { tool_name: 'Read', tool_detail: 'a' });
  f.message(3, 5); f.deliver(3, 5.2);
  f.tool('b', 6, null, { tool_name: 'Read', tool_detail: 'b' });
  const result = await read(f);
  assert.deepEqual(shown(result), ['read:a:done', 'mark:message', 'read:b:running']);
  assert.equal(result.steps[1].messageId, 3); assert.equal(result.steps[1].at, at(5.2));
  assert.equal(result.awaiting.id, 3, 'the latest unanswered message is the one in progress');
  assert.equal(result.seenId, 3);
});

test('scheduled tasks, system instructions and other inputs are marks of their own kind; a leading mark is dropped', async t => {
  const f = fixture(t, { now: at(30) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('a', 1, 2, { tool_name: 'Read', tool_detail: 'a' });
  f.message(50, 3, 'in', { channel: 'scheduler', endpoint_id: 'task' }); f.deliver(50, 3.2);
  f.tool('b', 4, 5, { tool_name: 'Read', tool_detail: 'b' });
  f.event('deliver', 6, { session: null, meta: { control_id: 12 } });
  f.message(51, 7, 'in', { channel: 'lark', endpoint_id: 'chat' }); f.deliver(51, 7.2);
  f.message(52, 8, 'in', { session_group: 'dash-owned:b' }); f.deliver(52, 8.2);
  f.tool('c', 9, null, { tool_name: 'Read', tool_detail: 'c' });
  const result = await read(f);
  assert.deepEqual(shown(result), ['read:a:done', 'mark:scheduled', 'read:b:done', 'mark:control', 'mark:other', 'mark:other', 'read:c:running']);
  assert.ok(!JSON.stringify(result).includes('message 5'), 'other inputs show only their kind, never their content');
});

test('a reply clears the steps before it and the work after it shows on its own', async t => {
  const f = fixture(t, { now: at(40) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('a', 1, 2, { tool_name: 'Read', tool_detail: 'before' });
  f.tool('same-second', 20.4, 21, { tool_name: 'Read', tool_detail: 'within the reply second' });
  f.message(2, 20, 'out');
  f.tool('b', 25, null, { tool_name: 'Read', tool_detail: 'after' });
  const result = await read(f);
  assert.deepEqual(shown(result), ['read:after:running'], 'a step started within the reply second counts before it');
  assert.equal(result.from, at(21));
  assert.equal(result.awaiting, null, 'answered');
  assert.equal(result.working.on, true);
});

test('the window starts where the group was last quiet, not at a stop a running subtask outlived', async t => {
  const f = fixture(t, { now: at(100) });
  f.message(1, -5);
  f.event('user_prompt_submit', 0); f.tool('old', 1, 2, { tool_name: 'Read', tool_detail: 'old' }); f.event('stop', 3);
  f.event('user_prompt_submit', 10); f.tool('kept', 11, 12, { tool_name: 'Read', tool_detail: 'kept' });
  f.event('subagent_start', 13, { meta: { agent_id: 'sub-1', agent_type: 'general-purpose' } });
  f.event('stop', 14);
  f.tool('later', 50, 51, { tool_name: 'Read', tool_detail: 'later' });
  f.event('subagent_stop', 60, { meta: { agent_id: 'sub-1' } }); f.event('stop', 70);
  f.clock.now = at(65);
  let result = await read(f);
  assert.equal(result.from, at(3), 'the stop at 14 left a subtask running');
  assert.deepEqual(shown(result), ['read:kept:done', 'mark:subtask:plain', 'read:later:done']);
  f.clock.now = at(100);
  result = await read(f);
  assert.equal(result.from, at(70)); assert.deepEqual(result.steps, []);
  assert.equal(result.working.on, false);
});

test('a subtask keeps the group working while the main agent is idle and is one row with its name and step count', async t => {
  const f = fixture(t, { now: at(60) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('launch', 1, 2, { tool_name: 'Agent', tool_detail: 'Check the lock file' });
  f.event('subagent_start', 1.5, { meta: { agent_id: 'named-1', agent_type: 'general-purpose' } });
  f.event('subagent_start', 3, { meta: { agent_id: 'sync-1', agent_type: 'zylos-group-sync' } });
  f.tool('c1', 4, 5, { tool_name: 'Read', tool_detail: 'sessions/today.md', agent_id: 'sync-1' });
  f.tool('c2', 6, null, { tool_name: 'Bash', tool_detail: 'Write the summary', detail_source: 'description', agent_id: 'sync-1' });
  f.tool('n1', 7, 8, { tool_name: 'Read', tool_detail: 'lock', agent_id: 'named-1' });
  f.message(2, 9, 'out'); f.event('stop', 10);
  let result = await read(f);
  assert.equal(result.working.on, true, 'the header still works');
  assert.equal(result.working.main, null, 'the main agent is idle');
  assert.deepEqual(result.subtasks.map(item => [item.id, item.label, item.start, item.steps]), [
    [subtaskKey('named-1'), { key: 'named', arg: 'Check the lock file' }, at(1.5), 1],
    [subtaskKey('sync-1'), { key: 'memorySync' }, at(3), 2]]);
  assert.ok(!JSON.stringify(result).includes('sync-1'), 'the agent id itself is never shown');
  assert.deepEqual(result.steps, [], 'nothing of the main agent since the reply');
  assert.ok(!shown(await read(f)).some(step => step.startsWith('read:sessions')), 'subtask steps never mix into the main steps');
  // Opening a row reads that subtask's own steps.
  const open = await read(f, { subtask: subtaskKey('sync-1') });
  assert.deepEqual(open.subtask, { id: subtaskKey('sync-1'), start: at(3), end: null });
  assert.deepEqual(shown(open), ['read:sessions/today.md:done', 'described:Write the summary:running']);
  // Before the reply, the main steps hold a mark where each subtask began; the launching call is not a step.
  f.db.prepare('DELETE FROM conversations WHERE id=2').run();
  result = await read(f);
  assert.equal(result.from, at(60) - 24 * 3600_000, 'the stop at 10 left subtasks running and no earlier stop exists');
  assert.deepEqual(result.steps, [], 'leading marks are dropped when there is no step before them');
  f.tool('main', 0.6, 0.8, { tool_name: 'Read', tool_detail: 'main' });
  result = await read(f);
  assert.deepEqual(shown(result), ['read:main:done', 'mark:subtask:named:Check the lock file', 'mark:subtask:memorySync']);
  // The subtask ends: it leaves the rows.
  f.event('subagent_stop', 70, { meta: { agent_id: 'sync-1' } }); f.event('subagent_stop', 71, { meta: { agent_id: 'named-1' } });
  f.clock.now = at(72);
  result = await read(f);
  assert.deepEqual(result.subtasks, []); assert.equal(result.working.on, false);
  assert.deepEqual(await read(f, { subtask: subtaskKey('sync-1') }), { now: at(72), subtask: null, steps: [] },
    'an ended subtask is no longer opened');
});

test('a subtask that never reported its end stops counting after the header\'s quiet limit', async t => {
  const f = fixture(t, { now: at(60) });
  f.message(1, -5, 'out');
  f.event('user_prompt_submit', 0);
  f.event('subagent_start', 1, { meta: { agent_id: 'lost', agent_type: 'general-purpose' } });
  f.event('stop', 2);
  assert.equal((await read(f)).subtasks.length, 1);
  f.clock.now = at(1) + TTL;
  const result = await read(f);
  assert.deepEqual(result.subtasks, []); assert.equal(result.working.on, false);
});

test('opening a subtask that is not running reads nothing, and a malformed or raw id is refused', async t => {
  const f = fixture(t);
  f.message(1, 0);
  f.event('subagent_start', 1, { meta: { agent_id: 'old', agent_type: 'general-purpose' } });
  f.event('subagent_stop', 2, { meta: { agent_id: 'old' } });
  assert.deepEqual(await read(f, { subtask: subtaskKey('nobody') }), { now: at(600), subtask: null, steps: [] });
  assert.deepEqual(await read(f, { subtask: subtaskKey('old') }), { now: at(600), subtask: null, steps: [] });
  for (const bad of ['old', 'bad id;', 'x'.repeat(23), '/root/task_name_here_ok'])
    await assert.rejects(read(f, { subtask: bad }), { code: 'invalid_chat_subtask' }, bad);
});

test('work that ended without a reply is handled once it settled; until then it is still being thought about', async t => {
  const f = fixture(t, { now: at(15) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('a', 1, 2, { tool_name: 'Read', tool_detail: 'a' });
  f.event('stop', 5);
  let result = await read(f);
  assert.equal(result.awaiting.state, 'thinking', 'a queued message may still start work just after the stop');
  f.clock.now = at(5) + SETTLE_MS;
  result = await read(f);
  assert.deepEqual(result.awaiting, { id: 1, state: 'handled', since: at(0), delivered: at(0.2) });
  assert.equal(result.working.on, false);
  // Work that starts again after the stop is not handled.
  f.tool('b', 26, null, { tool_name: 'Read', tool_detail: 'b' });
  f.clock.now = at(27);
  result = await read(f);
  assert.equal(result.awaiting.state, 'thinking');
  assert.deepEqual(shown(result), ['read:b:running']);
});

test('a delivered message that never led to a stop gives up after the pending limit; a queued one waits in C4', async t => {
  const f = fixture(t, { now: at(100) });
  f.message(1, 0); f.deliver(1, 1);
  assert.equal((await read(f)).awaiting.state, 'thinking');
  f.clock.now = at(1 + 31 * 60);
  assert.equal((await read(f)).awaiting, null);
  f.message(2, 1900, 'in', { status: 'pending' });
  f.clock.now = at(1900 + 600);
  assert.equal((await read(f)).awaiting.state, 'queued', 'still in the C4 queue');
  f.db.prepare("UPDATE conversations SET status='delivered' WHERE id=2").run();
  assert.equal((await read(f)).awaiting, null, 'left the queue long ago and was never delivered');
});

test('a stop ends the work at once; at a stop a subtask outlived, open steps run on while it settles', async t => {
  const f = fixture(t, { now: at(8) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.event('subagent_start', 0.5, { meta: { agent_id: 'sub', agent_type: 'general-purpose' } });
  f.tool('late', 1, null, { tool_name: 'Read', tool_detail: 'late' });
  f.tool('lost', 2, null, { tool_name: 'Read', tool_detail: 'lost' });
  f.event('runtime_health:stop_failure', 5);
  f.clock.now = at(5) + SETTLE_MS - 1;
  assert.deepEqual(shown(await read(f)), ['read:late:running', 'read:lost:running'], 'their ends may not be collected yet');
  f.event('post_tool_use', 4, { meta: { tool_use_id: 'late', tool_name: 'Read', tool_detail: 'late' } });
  f.clock.now = at(5) + SETTLE_MS;
  let result = await read(f);
  assert.deepEqual(result.steps.map(step => [step.label.arg, step.status, step.end]), [['late', 'done', at(4)], ['lost', 'incomplete', at(5)]]);
  // Once the subtask ended and the main agent stopped again, the group is quiet and the area has nothing left.
  f.event('subagent_stop', 30, { meta: { agent_id: 'sub' } }); f.event('stop', 31);
  f.clock.now = at(32);
  result = await read(f);
  assert.equal(result.from, at(31)); assert.deepEqual(result.steps, []); assert.equal(result.working.on, false);
});

test('an interrupt stops the open steps only once its Escape reached the session', async t => {
  const f = fixture(t, { now: at(40) });
  f.event('stop', -10);
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('job', 2, null, { tool_name: 'Bash', tool_detail: 'Long job', detail_source: 'description' });
  f.event('dashboard_interrupt', 5, { session: null, meta: { control_id: 9 } });
  for (const status of [null, 'pending', 'running', 'failed', 'timeout']) {
    f.db.prepare('DELETE FROM control_queue').run();
    if (status) f.control(9, status, 6);
    const result = await read(f);
    assert.equal(result.from, at(-10), `control ${status}: not a stop`);
    assert.deepEqual(shown(result), ['described:Long job:running'], `control ${status}`);
  }
  f.db.prepare('DELETE FROM control_queue').run();
  f.control(9, 'done', 8);
  const result = await read(f);
  assert.equal(result.from, at(8), 'the group was quiet from the delivered Escape');
  assert.deepEqual(result.steps, []);
});

test('steps open at a delivered interrupt are stopped and the rest of the window is kept', async t => {
  const f = fixture(t, { now: at(40) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.event('subagent_start', 1, { meta: { agent_id: 'sub', agent_type: 'general-purpose' } });
  f.tool('job', 2, null, { tool_name: 'Bash', tool_detail: 'Long job', detail_source: 'description' });
  f.event('dashboard_interrupt', 5, { session: null, meta: { control_id: 9 } }); f.control(9, 'done', 6);
  const result = await read(f);
  assert.equal(result.from, at(40) - 24 * 3600_000, 'no quiet moment: the window reaches back a day');
  assert.deepEqual(shown(result), ['described:Long job:stopped'], 'a subtask was still open, so the window did not move');
  assert.equal(result.steps[0].end, at(6));
});

test('more steps than the area shows keeps the newest and says older ones were left out', async t => {
  const f = fixture(t, { now: at(2000) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.bulk(() => { for (let i = 0; i < 520; i++) f.tool(`t${i}`, 1 + i * 2, 2 + i * 2, { tool_name: 'Read', tool_detail: `f${i}` }); });
  const result = await read(f);
  assert.equal(result.truncated, true);
  assert.equal(result.steps.length, 500);
  assert.equal(result.steps.at(-1).label.arg, 'f519'); assert.equal(result.steps[0].label.arg, 'f20');
});

test('Codex: commands and edits from the rollout, hook duplicates and subagent controls left out, a subtask is a mark', async t => {
  const f = fixture(t, { now: at(30) });
  const codex = { runtime: 'codex', session: 'thread-1' };
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0, codex);
  f.event('pre_tool_use', 1, { ...codex, meta: { tool_use_id: 'h1', tool_name: 'Bash' } });
  f.event('tool_call', 1, { ...codex, meta: { call_id: 'c1', tool_name: 'exec_command' } });
  f.event('tool_result', 2, { ...codex, meta: { call_id: 'c1', tool_name: 'exec_command', outcome: 'failed' } });
  f.event('tool_call', 3, { ...codex, summary: 'Edit files: /isolated/zylos/a/b/c/d.md', meta: { call_id: 'c2', tool_name: 'apply_patch' } });
  f.event('tool_result', 4, { ...codex, meta: { call_id: 'c2', tool_name: 'apply_patch', outcome: 'succeeded' } });
  f.event('tool_call', 5, { ...codex, meta: { call_id: 'c3', tool_name: 'spawn_agent' } });
  f.event('subagent_start', 6, { ...codex, meta: { agent_id: 'x', description: 'Look at logs', nickname: 'Kepler' } });
  f.event('tool_call', 7, { ...codex, meta: { call_id: 'c4', tool_name: 'wait_agent', agent_id: 'x' } });
  f.event('tool_call', 8, { ...codex, meta: { call_id: 'c5', tool_name: 'exec', wraps_agent_tools: ['spawn_agent'] } });
  f.event('assistant_message', 21, { ...codex, summary: 'Done looking.' });
  const result = await read(f);
  assert.deepEqual(shown(result), ['runCommand::failed', 'edit:b/c/d.md:done', 'mark:subtask:plain', 'say:Done looking.']);
  assert.deepEqual(result.subtasks.map(item => [item.id, item.label]), [[subtaskKey('x'), { key: 'plain' }]]);
  // The response as the route sends it: the subtask's count, never its agent id.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result)).working.subagents), ['count', 'since', 'lastActivityAt']);
  assert.ok(!JSON.stringify(result).includes('Look at logs'), 'the message a subtask was given is never shown');
});

// The real rollout collector writes into the same Dashboard store the activity is read from.
// Each pass reads what one collection cycle reads (at most 200 lines or 256 KB); a later pass starts where it stopped.
async function collectRollout(f, name, lines, { passes = 1 } = {}) {
  const file = path.join(f.root, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const mapping = { transcript_path: file, session_id: 'thread-1', session_group: GROUP, run_id: 'r1' };
  f.store.insertUsageTranscript({ ...mapping, runtime: 'codex' }, new Date(T0).toISOString());
  const transcripts = { snapshot: { listKnown: true }, currentOriginMapping: () => null, isOriginCurrent: () => false,
    async collect(runtime, callback) { return (await callback(mapping, false)).written; } };
  for (let pass = 0; pass < passes; pass++) await new CodexRolloutCollector(f.store, { modelPrices: {} }, { transcripts }).collect();
  return file;
}
const PRIVATE = ['<redacted', 'zylo131', 'plan_audit', 'single_session', 'triage_new', 'Kierkegaard', V1_CHILD, '"hi"'];
function assertNothingPrivate(result, name) {
  const text = JSON.stringify(result);
  for (const secret of PRIVATE) assert.ok(!text.includes(secret), `${name}: ${secret} is not shown`);
}
// Message 1 at 0 s, then recorded Codex lines collected from their rollout.
async function codexWork(t, lines, { child = null, now } = {}) {
  const f = fixture(t, { now: now ?? Date.parse(lines.at(-1).timestamp) + 1000 });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0, { runtime: 'codex', session: 'thread-1' });
  f.tool('first', 0.5, 0.6, { tool_name: 'Read', tool_detail: 'first' });
  await collectRollout(f, 'parent', lines);
  if (child) await collectRollout(f, 'child', child);
  return f;
}

test('a recorded Codex v2 subtask is a mark and, while it runs, a row; its spawn, wait and interrupt calls are not steps', async t => {
  for (const [name, lines] of [['completed', v2CompletedTurn(at(1))], ['interrupted', v2InterruptedTurn(at(1))]]) {
    const f = await codexWork(t, lines);
    const result = await read(f);
    assert.deepEqual(shown(result), ['read:first:done', 'mark:subtask:plain'], name);
    assertNothingPrivate(result, name);
    assert.deepEqual(result.subtasks, [], `${name}: ended`);
  }
  const lines = v2CompletedTurn(at(1));
  const f = await codexWork(t, lines.filter(line => !(line.payload.item?.type === 'SubAgentActivity' && line.payload.item.kind === 'completed')));
  const running = await read(f);
  assert.equal(running.subtasks.length, 1, 'a subtask whose wait timed out still runs');
  assert.equal(running.working.on, true);
  assertNothingPrivate(running, 'running');
  const steps = await read(f, { subtask: running.subtasks[0].id });
  assert.equal(steps.subtask.id, running.subtasks[0].id);
  assertNothingPrivate(steps, 'running subtask');
});

test('a recorded Codex v1 subtask run from code mode is a mark, not two commands, and its own thread adds no main steps', async t => {
  const parent = v1ParentTurn(at(1)), child = v1ChildRollout(at(1));
  const f = await codexWork(t, parent.filter(line => line.payload.type !== 'task_complete'), { child });
  const result = await read(f);
  assert.deepEqual(shown(result), ['read:first:done', 'mark:subtask:plain']);
  assert.deepEqual(result.subtasks, [], 'its wait saw it complete');
  assertNothingPrivate(result, 'v1');
  // The turn end the parent records is a stop, and with no subtask left the group is quiet: the work is over.
  const ended = await codexWork(t, parent, { child });
  assert.deepEqual((await read(ended)).steps, []);
});

test('a recorded code-mode command that yields is one running step until the wait that sees it finish', async t => {
  for (const [name, recorded] of [['0.153.4', CELL_A_LINES], ['0.166.0 with inner commands', CELL_B_LINES], ['0.166.0', CELL_C_LINES],
    ['0.163.0 yielding printed content', CELL_D_LINES]]) {
    const lines = rebase(recorded, at(1));
    const finish = lines.findLastIndex(line => line.payload.type === 'function_call_output');
    const live = await codexWork(t, lines.slice(0, finish));
    assert.deepEqual(shown(await read(live)), ['read:first:done', 'runCommand::running'], `${name}: running while every wait says so`);
    const done = await codexWork(t, lines);
    const result = await read(done);
    assert.deepEqual(shown(result), ['read:first:done', 'runCommand::done'], `${name}: its waits and inner commands are not steps`);
    assert.equal(result.steps[1].start, Date.parse(lines[0].timestamp));
    assert.equal(result.steps[1].end, Date.parse(lines[finish].timestamp));
    assertNothingPrivate(result, name);
  }
});

test('a code-mode command whose script failed or was terminated is a failed step', async t => {
  for (const header of ['Script failed', 'Script terminated']) {
    const f = await codexWork(t, rebase(cellEndingAs(header), at(1)));
    assert.deepEqual(shown(await read(f)), ['read:first:done', 'runCommand::failed'], header);
  }
});

test('a code-mode command no wait saw finish runs on, and ends where the main agent stopped once that settled', async t => {
  const lines = rebase(cellPolledInNewExec(), at(1));
  const f = await codexWork(t, lines, { now: at(20) });
  assert.deepEqual(shown(await read(f)), ['read:first:done', 'runCommand::running', 'runCommand::done']);
  // A subtask still runs at the stop, so the work stays in view.
  f.event('subagent_start', 24, { runtime: 'codex', session: 'thread-1', meta: { agent_id: 'keep-open' } });
  f.event('turn_complete', 25, { runtime: 'codex', session: 'thread-1' });
  f.clock.now = at(26);
  assert.deepEqual(shown(await read(f)), ['read:first:done', 'runCommand::running', 'runCommand::done', 'mark:subtask:plain'], 'still settling');
  f.clock.now = at(25) + SETTLE_MS;
  const result = await read(f);
  assert.deepEqual(shown(result), ['read:first:done', 'runCommand::done', 'runCommand::done', 'mark:subtask:plain'],
    'not unfinished: a yielded command no wait saw ends with the stop');
  assert.equal(result.steps[1].start, Date.parse(lines[0].timestamp)); assert.equal(result.steps[1].end, at(25));
});

// Integration: real auth gate, history routes, SQLite and a private loopback server only.
// Run for activity route or chat access changes; skip for styles or text changes.
// Uses the runner-isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no process or tmux launch.
test('the activity route uses the chat access rules and accepts only tab and subtask', async t => {
  const f = fixture(t, { now: at(10) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('a', 1, null, { tool_name: 'Read', tool_detail: 'a' });
  f.event('subagent_start', 2, { meta: { agent_id: 'sync-1', agent_type: 'zylos-origin-sync' } });
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = 'activity-browser-session';
  f.store.insertSession(hash(cookie), Date.now());
  const config = { auth: { enabled: true, password: 'scrypt:test' }, chat: { allowRemote: false } };
  const auth = new AuthGate(config, f.store);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url)) return;
    if (await handleChatHistory(req, res, url, { auth, config, history: f.history, activity: f.activity })) return;
    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { clearInterval(auth._cleanupTimer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (route, withCookie = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`,
      { headers: withCookie ? { cookie: `__Secure-zylos_dashboard_session=${cookie}` } : {} });
    return { status: response.status, body: await response.json() };
  };
  const ok = await request(`/api/chat/conversations/${ID}/activity?tab=mine`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.working.on, true); assert.equal(ok.body.steps[0].label.arg, 'a');
  assert.deepEqual(ok.body.subtasks.map(item => item.label), [{ key: 'memorySync' }]);
  const open = await request(`/api/chat/conversations/${ID}/activity?tab=mine&subtask=${subtaskKey('sync-1')}`);
  assert.equal(open.status, 200); assert.equal(open.body.subtask.id, subtaskKey('sync-1'));
  assert.equal((await request(`/api/chat/conversations/${ID}/activity?tab=mine`, false)).status, 401);
  for (const suffix of ['tab=mine&extra=1', 'tab=mine&ids=1', 'tab=mine&tab=mine', 'tab=mine&subtask=a&subtask=b', 'tab=mine&subtask=bad%20id',
    'tab=external'])
    assert.ok((await request(`/api/chat/conversations/${ID}/activity?${suffix}`)).status >= 400, suffix);
});

test('a Dashboard database one version older gains the group, type and time index, and activity lookups use it', async t => {
  const f = fixture(t, { now: at(30) });
  const db = f.store.db;
  db.exec('DROP INDEX idx_events_group_type_ts; DELETE FROM schema_migrations WHERE version=27');
  migrateDatabase(db);
  assert.equal(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), TARGET_SCHEMA_VERSION);
  assert.deepEqual(db.pragma('index_info(idx_events_group_type_ts)').map(column => column.name), ['session_group', 'event_type', 'timestamp']);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('a', 2, 3, { tool_name: 'Read', tool_detail: 'a' }); f.event('stop', 5);
  const seen = [], prepare = db.prepare.bind(db);
  db.prepare = sql => { seen.push(sql); return prepare(sql); };
  try { await read(f); } finally { db.prepare = prepare; }
  const lookups = seen.filter(sql => /FROM runtime_events\s+WHERE session_group=@group\s+AND event_type\s*(IN|=)/.test(sql));
  assert.ok(lookups.length >= 3, 'stops, steps and delivery');
  for (const sql of lookups) {
    const parameters = Object.fromEntries([...sql.matchAll(/@(\w+)/g)].map(([, name]) => [name, 'x']));
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameters).map(row => row.detail).join(' | ');
    assert.match(plan, /USING INDEX idx_events_group_type_ts/, sql.slice(0, 80));
  }
});
