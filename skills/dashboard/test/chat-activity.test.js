import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { AuthGate } from '../src/lib/auth.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatActivity, buildSegments, stepLabel } from '../src/lib/chat/activity.js';
import { handleChatHistory } from '../src/lib/chat/history-routes.js';
import { sendJson } from '../src/lib/http.js';
import { migrateDatabase, TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { V1_CHILD, V1_SPAWN_EXEC, V1_WAIT_EXEC, codeModeYieldedCommand, v1ChildRollout, v1LongChildRollout, v1ParentTurn,
  v1YieldedWaitTurn, v2CompletedTurn, v2InterruptedTurn, v2TimedOutTurn } from './fixtures/codex-multi-agent-rollout.js';

const GROUP = 'dash-owned:a';
const ID = `g:${Buffer.from(GROUP).toString('hex').toUpperCase()}`;
const T0 = Date.parse('2026-11-08T10:00:00.000Z');
const at = seconds => T0 + seconds * 1000;
const c4 = seconds => new Date(at(seconds)).toISOString().replace('T', ' ').slice(0, 19);

// Temporary c4 and dashboard SQLite files only; no runtime, Core or outside network.
function fixture(t, { now = at(600) } = {}) {
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
  const clock = { now };
  const activity = new ChatActivity({ history, store, now: () => clock.now });
  const insert = db.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,session_group,content,status,delivery_action)
    VALUES (@id,@timestamp,@direction,@channel,@endpoint_id,@session_group,@content,@status,NULL)`);
  const message = (id, seconds, direction = 'in', extra = {}) => insert.run({ id, timestamp: c4(seconds), direction,
    channel: 'dashboard', endpoint_id: 'a', session_group: GROUP, content: `message ${id}`, status: 'delivered', ...extra });
  const event = (type, seconds, fields = {}) => store.insertEvent({ id: crypto.randomUUID(), ingest_id: crypto.randomUUID(),
    timestamp: new Date(at(seconds)).toISOString(), runtime: fields.runtime ?? 'claude', session_id: fields.session ?? 's1',
    session_group: fields.group ?? GROUP, run_id: 'r1', event_type: type, category: 'test', summary: fields.summary ?? null,
    metadata: fields.meta ?? {}, source: 'test' });
  const deliver = (id, seconds) => event('deliver', seconds, { meta: { conversation_id: id }, session: null });
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
const read = (f, ids) => f.activity.activity(ID, { tab: 'mine', ids: ids.join(',') });
const roundOf = (result, id) => {
  const item = result.items.find(entry => entry.id === id);
  return item?.state === 'round' ? result.rounds.find(round => round.key === item.round) : null;
};
const toolSteps = segment => segment.steps.filter(step => step.kind !== 'say');

test('one round runs from the turn its message started to the stop, with plain labels and its reply', t => {
  const f = fixture(t);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('read', 2, 3, { tool_name: 'Read', tool_detail: 'memory/state.md' });
  f.tool('cmd', 4, 6, { tool_name: 'Bash', tool_detail: 'Check disk space', detail_source: 'description' });
  f.tool('raw', 7, 8, { tool_name: 'Bash', tool_detail: 'df -h /secret/path', detail_source: 'command' });
  f.event('assistant_message', 9, { summary: 'Found it.' });
  f.tool('agent', 10, 40, { tool_name: 'Agent', tool_detail: 'Check the lock file' });
  f.tool('child', 12, 13, { tool_name: 'Read', tool_detail: 'x', agent_id: 'sub-1' });
  f.tool('other-session', 14, 15, { tool_name: 'Read', tool_detail: 'y' });
  f.store.db.prepare("UPDATE runtime_events SET session_id='s2' WHERE json_extract(metadata,'$.tool_use_id')='other-session'").run();
  f.message(2, 42, 'out'); f.event('stop', 43);
  const result = read(f, [1]);
  const round = roundOf(result, 1);
  assert.equal(round.state, 'done'); assert.equal(round.start, at(0.5)); assert.equal(round.end, at(43));
  assert.deepEqual(round.messageIds, [1]);
  assert.equal(round.segments.length, 2);
  const [first, tail] = round.segments;
  assert.equal(first.replyId, 2); assert.equal(first.start, at(0.5)); assert.equal(first.end, at(42));
  assert.deepEqual(first.steps.map(step => step.kind === 'say' ? ['say', step.text] : [step.label.key, step.label.arg ?? null, step.status]), [
    ['read', 'memory/state.md', 'done'], ['described', 'Check disk space', 'done'], ['runCommand', null, 'done'],
    ['say', 'Found it.'], ['subagent', 'Check the lock file', 'done']]);
  assert.ok(!JSON.stringify(result).includes('df -h'), 'a summarized command line is never shown');
  assert.equal(first.steps.find(step => step.label?.key === 'read').end - first.steps.find(step => step.label?.key === 'read').start, 1000);
  assert.equal(tail.replyId, null); assert.equal(tail.steps.length, 0); assert.equal(tail.end, at(43));
});

test('a message sent while the agent works joins the running round and there is one activity for both', t => {
  const f = fixture(t);
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.5);
  f.tool('a', 1, 2, { tool_name: 'Read', tool_detail: 'a' });
  f.message(3, 5); f.deliver(3, 5.2);
  f.tool('b', 6, 7, { tool_name: 'Read', tool_detail: 'b' });
  f.message(4, 9, 'out'); f.event('stop', 10);
  const result = read(f, [1, 3]);
  assert.equal(result.rounds.length, 1);
  const round = roundOf(result, 3);
  assert.equal(round, roundOf(result, 1));
  assert.deepEqual(round.messageIds, [1, 3]);
  assert.equal(toolSteps(round.segments[0]).length, 2, 'earlier steps stay with the moved activity');
});

test('a message the runtime takes as a fresh turn right after the stop continues the same round', t => {
  const f = fixture(t);
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0.5);
  f.tool('a', 1, 2, { tool_name: 'Read', tool_detail: 'a' });
  f.message(3, 3); f.deliver(3, 3.2);
  f.event('stop', 4); f.event('user_prompt_submit', 5);
  f.tool('b', 6, 7, { tool_name: 'Read', tool_detail: 'b' });
  f.message(5, 8, 'out'); f.event('stop', 9);
  f.message(6, 30); f.deliver(6, 30.2); f.event('user_prompt_submit', 30.4); f.event('stop', 31);
  const result = read(f, [1, 3, 6]);
  const round = roundOf(result, 1);
  assert.deepEqual(round.messageIds, [1, 3]); assert.equal(round.end, at(9)); assert.equal(round.state, 'done');
  assert.equal(toolSteps(round.segments[0]).length, 2);
  assert.notEqual(roundOf(result, 6), round);
  assert.equal(roundOf(result, 6).start, at(30.4));
});

test('replies split a round; each part counts only its own time and the parts add up to the round', t => {
  const f = fixture(t);
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0);
  f.tool('a', 2, 3, { tool_name: 'Read', tool_detail: 'a' });
  f.message(2, 20, 'out');
  f.tool('b', 25, 30, { tool_name: 'Read', tool_detail: 'b' });
  f.tool('c', 31, 32, { tool_name: 'Read', tool_detail: 'c' });
  f.message(3, 60, 'out'); f.event('stop', 61);
  const round = roundOf(read(f, [1]), 1);
  const [one, two, tail] = round.segments;
  assert.deepEqual([one.replyId, two.replyId, tail.replyId], [2, 3, null]);
  assert.deepEqual([toolSteps(one).length, toolSteps(two).length, toolSteps(tail).length], [1, 2, 0]);
  assert.equal(one.end - one.start, 20000); assert.equal(two.end - two.start, 40000);
  assert.equal(round.segments.reduce((sum, part) => sum + (part.end - part.start), 0), round.end - round.start);
});

test('a running round has no end, its open step is running and later steps come in time order', t => {
  const f = fixture(t, { now: at(50) });
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0);
  f.tool('a', 1, 2, { tool_name: 'Read', tool_detail: 'a' });
  f.tool('b', 3, null, { tool_name: 'Read', tool_detail: 'b' });
  const result = read(f, [1]);
  const round = roundOf(result, 1);
  assert.equal(round.state, 'running'); assert.equal(round.end, null); assert.equal(result.now, at(50));
  assert.deepEqual(toolSteps(round.segments[0]).map(step => step.status), ['done', 'running']);
});

test('failed, stopped and unfinished steps are told apart', t => {
  const f = fixture(t);
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0);
  f.tool('bad', 1, 2, { tool_name: 'Read', tool_detail: 'a' }, 'post_tool_failure');
  f.tool('open', 3, null, { tool_name: 'Read', tool_detail: 'b' });
  f.event('stop', 5);
  f.message(2, 10); f.deliver(2, 10.2); f.event('user_prompt_submit', 10.4);
  f.tool('cut', 11, null, { tool_name: 'Bash', tool_detail: 'Long job', detail_source: 'description' });
  f.event('dashboard_interrupt', 15, { session: null, meta: { control_id: 7 } });
  f.control(7, 'done', 16);
  const result = read(f, [1, 2]);
  const first = roundOf(result, 1), second = roundOf(result, 2);
  assert.deepEqual(toolSteps(first.segments[0]).map(step => step.status), ['failed', 'incomplete']);
  assert.equal(first.state, 'done');
  assert.equal(second.state, 'stopped'); assert.equal(second.end, at(16), 'the round ends when the Escape was delivered');
  assert.deepEqual(toolSteps(second.segments[0]).map(step => [step.status, step.end]), [['stopped', at(16)]]);
});

test('scheduled and other hidden inputs keep their own turns; a visible message during one starts at its delivery', t => {
  const f = fixture(t);
  f.message(1, 0, 'in', { channel: 'scheduler', endpoint_id: 'task' });
  f.deliver(1, 0.2); f.event('user_prompt_submit', 0.4);
  f.tool('hidden', 1, 2, { tool_name: 'Read', tool_detail: 'scheduler stuff' });
  f.message(2, 5); f.deliver(2, 5.2);
  f.tool('mine', 6, 7, { tool_name: 'Read', tool_detail: 'mine' });
  f.message(3, 8, 'out'); f.event('stop', 9);
  f.deliver(77, 20); f.event('user_prompt_submit', 20.2); f.tool('later', 21, 22, { tool_name: 'Read', tool_detail: 'later' }); f.event('stop', 23);
  const result = read(f, [2]);
  const round = roundOf(result, 2);
  assert.equal(round.start, at(5.2));
  assert.deepEqual(round.messageIds, [2]);
  assert.deepEqual(toolSteps(round.segments[0]).map(step => step.label.arg), ['mine']);
  assert.equal(result.rounds.length, 1);
});

test('messages without a turn yet are pending, old undelivered ones and replies have no activity', t => {
  const f = fixture(t, { now: at(100) });
  f.message(1, 99); f.deliver(1, 99.5);
  f.message(2, 98);
  f.message(3, -300);
  f.message(4, 1, 'out');
  const result = read(f, [1, 2, 3, 4]);
  const state = id => result.items.find(item => item.id === id).state;
  assert.deepEqual([state(1), state(2), state(3), state(4)], ['pending', 'pending', 'none', 'none']);
  assert.equal(result.rounds.length, 0);
  f.clock.now = at(100 + 31 * 60);
  assert.equal(read(f, [1]).items[0].state, 'none', 'a delivery that never started a turn stops being polled');
});

test('a message queued past two minutes keeps waiting for its round instead of being given up', t => {
  const f = fixture(t, { now: at(200) });
  f.message(1, 0, 'in', { status: 'running' });
  f.message(2, 10);
  f.event('activate_new', 150, { meta: { conversation_id: 2 }, session: null });
  f.message(3, 20);
  const first = read(f, [1, 2, 3]);
  const state = (result, id) => result.items.find(item => item.id === id).state;
  assert.equal(state(first, 1), 'pending', 'still queued in C4');
  assert.equal(state(first, 2), 'pending', 'delivered, the router logged it, its delivery record is not imported yet');
  assert.equal(state(first, 3), 'none', 'left the queue long ago and the router never logged it');
  f.db.prepare("UPDATE conversations SET status='delivered' WHERE id=1").run();
  f.event('user_prompt_submit', 205); f.deliver(1, 205.2); f.tool('a', 206, 207); f.event('stop', 210);
  f.clock.now = at(212);
  const later = read(f, [1]);
  assert.equal(state(later, 1), 'round');
  assert.equal(roundOf(later, 1).segments.at(-1).steps.length, 1);
});

test('a routed message that never starts a turn stops being polled for after the pending limit', t => {
  const f = fixture(t, { now: at(31 * 60) });
  f.message(1, 0);
  f.event('activate_new', 5, { meta: { conversation_id: 1 }, session: null });
  f.message(2, 0, 'in', { status: 'running' });
  const result = read(f, [1, 2]);
  assert.equal(result.items.find(item => item.id === 1).state, 'none', 'left the queue, logged once, nothing for 31 minutes');
  assert.equal(result.items.find(item => item.id === 2).state, 'pending', 'still queued in C4');
});

test('Codex steps come from the rollout with its failure flag; hook duplicates and subagent controls are left out', t => {
  const f = fixture(t);
  const codex = { runtime: 'codex', session: 'thread-1' };
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0, codex);
  f.event('pre_tool_use', 1, { ...codex, meta: { tool_use_id: 'h1', tool_name: 'Bash' } });
  f.event('tool_call', 1, { ...codex, meta: { call_id: 'c1', tool_name: 'exec_command' } });
  f.event('tool_result', 2, { ...codex, meta: { call_id: 'c1', tool_name: 'exec_command', outcome: 'failed' } });
  f.event('tool_call', 3, { ...codex, summary: 'Edit files: /isolated/zylos/a/b/c/d.md', meta: { call_id: 'c2', tool_name: 'apply_patch' } });
  f.event('tool_result', 4, { ...codex, meta: { call_id: 'c2', tool_name: 'apply_patch', outcome: 'succeeded' } });
  f.event('tool_call', 5, { ...codex, meta: { call_id: 'c3', tool_name: 'spawn_agent' } });
  f.event('subagent_start', 6, { ...codex, meta: { agent_id: 'x', description: 'Look at logs' } });
  f.event('tool_call', 7, { ...codex, meta: { call_id: 'c4', tool_name: 'wait_agent', agent_id: 'x' } });
  f.event('subagent_stop', 20, { ...codex, meta: { agent_id: 'x' } });
  f.event('assistant_message', 21, { ...codex, summary: 'Done looking.' });
  f.event('turn_complete', 22, codex); f.event('stop', 22.1, codex);
  const round = roundOf(read(f, [1]), 1);
  assert.deepEqual(round.segments[0].steps.map(step => step.kind === 'say' ? 'say' : `${step.label.key}:${step.label.arg ?? ''}:${step.status}`),
    ['runCommand::failed', 'edit:b/c/d.md:done', 'subagent::done', 'say']);
  assert.ok(!JSON.stringify(round).includes('Look at logs'), 'the message a subagent was given is never shown');
  assert.equal(round.end, at(22));
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

test('segments place a step started within the reply second before that reply', () => {
  const steps = [{ start: at(10.4) }, { start: at(11.2) }];
  const parts = buildSegments(steps, [{ id: 9, at: at(10) }], { start: at(0), end: at(20) });
  assert.deepEqual(parts.map(part => part.steps.length), [1, 1]);
});

// Integration: real auth gate, history routes, SQLite and a private loopback server only.
// Run for activity route or chat access changes; skip for styles or text changes.
// Uses the runner-isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no process or tmux launch.
test('the activity route uses the chat access rules and accepts only tab and ids', async t => {
  const f = fixture(t);
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0); f.event('stop', 3);
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
  const ok = await request(`/api/chat/conversations/${ID}/activity?tab=mine&ids=1`);
  assert.equal(ok.status, 200); assert.equal(ok.body.items[0].state, 'round'); assert.equal(ok.body.rounds[0].state, 'done');
  assert.equal((await request(`/api/chat/conversations/${ID}/activity?tab=mine&ids=1`, false)).status, 401);
  for (const suffix of ['tab=mine&ids=1&extra=1', 'tab=mine&ids=1&ids=1', 'tab=mine&ids=', 'tab=mine&ids=1,1', 'tab=external&ids=1', 'tab=mine&ids=999'])
    assert.ok((await request(`/api/chat/conversations/${ID}/activity?${suffix}`)).status >= 400, suffix);
});

test('an interrupt ends its round only after the Escape reached the session', t => {
  const f = fixture(t, { now: at(40) });
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('job', 2, null, { tool_name: 'Bash', tool_detail: 'Long job', detail_source: 'description' });
  f.event('dashboard_interrupt', 5, { session: null, meta: { control_id: 9 } });
  for (const status of [null, 'pending', 'running', 'failed', 'timeout']) {
    f.db.prepare('DELETE FROM control_queue').run();
    if (status) f.control(9, status, 6);
    const round = roundOf(read(f, [1]), 1);
    assert.equal(round.state, 'running', `control ${status}`); assert.equal(round.end, null);
    assert.equal(toolSteps(round.segments[0])[0].status, 'running');
  }
  f.db.prepare('DELETE FROM control_queue').run();
  f.control(9, 'done', 8);
  const round = roundOf(read(f, [1]), 1);
  assert.equal(round.state, 'stopped'); assert.equal(round.end, at(8));
  assert.equal(toolSteps(round.segments[0])[0].status, 'stopped');
});

test('just after a round ends it is settling: unfinished steps keep running and late events still show', t => {
  const f = fixture(t, { now: at(25) });
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('read', 2, null, { tool_name: 'Read', tool_detail: 'a' });
  f.message(2, 18, 'out'); f.event('stop', 20);
  let round = roundOf(read(f, [1]), 1);
  assert.equal(round.state, 'done'); assert.equal(round.settling, true);
  assert.equal(toolSteps(round.segments[0])[0].status, 'running', 'its end may not be collected yet');
  // The collectors catch up: the tool end and the words said before the reply arrive after the stop.
  f.event('post_tool_use', 3, { meta: { tool_use_id: 'read', tool_name: 'Read', tool_detail: 'a' } });
  f.event('assistant_message', 17, { summary: 'Checked.' });
  f.tool('lost', 4, null, { tool_name: 'Read', tool_detail: 'b' });
  round = roundOf(read(f, [1]), 1);
  assert.deepEqual(round.segments[0].steps.map(step => step.kind === 'say' ? step.text : step.status), ['done', 'running', 'Checked.']);
  f.clock.now = at(40);
  round = roundOf(read(f, [1]), 1);
  assert.equal(round.settling, undefined, 'settled twenty seconds after the end');
  assert.deepEqual(toolSteps(round.segments[0]).map(step => [step.status, step.end]), [['done', at(3)], ['incomplete', at(20)]]);
});

test('a message taken as a new turn after a settling round reopens that round on the next read', t => {
  const f = fixture(t, { now: at(23) });
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('a', 2, 3, { tool_name: 'Read', tool_detail: 'a' });
  f.message(2, 10); f.deliver(2, 10.2);
  f.message(3, 19, 'out'); f.event('stop', 20);
  let round = roundOf(read(f, [1, 2]), 2);
  assert.equal(round.key, '1'); assert.equal(round.state, 'done'); assert.equal(round.settling, true);
  // The runtime takes message 2 as a fresh turn a few seconds after the stop.
  f.event('user_prompt_submit', 26); f.tool('b', 27, null, { tool_name: 'Read', tool_detail: 'b' });
  f.clock.now = at(28);
  round = roundOf(read(f, [1, 2]), 2);
  assert.equal(round.state, 'running'); assert.equal(round.end, null);
  assert.deepEqual(round.segments.map(part => [part.replyId, toolSteps(part).map(step => `${step.label.arg}:${step.status}`)]),
    [[3, ['a:done']], [null, ['b:running']]]);
});

test('a turn that starts more than ten seconds after the stop is not taken as the same round', t => {
  const f = fixture(t);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.message(2, 5); f.deliver(2, 5.2);
  f.event('stop', 20);
  f.event('user_prompt_submit', 30.5); f.tool('late', 32, 33, { tool_name: 'Read', tool_detail: 'x' }); f.event('stop', 40);
  const round = roundOf(read(f, [1, 2]), 1);
  assert.equal(round.end, at(20));
  assert.equal(round.segments.reduce((sum, part) => sum + part.steps.length, 0), 0);
});

test('a stopped round does not take the next turn even when a message was waiting', t => {
  const f = fixture(t);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.message(2, 5); f.deliver(2, 5.2);
  f.event('dashboard_interrupt', 8, { session: null, meta: { control_id: 3 } }); f.control(3, 'done', 8);
  f.event('user_prompt_submit', 10); f.tool('after', 11, 12, { tool_name: 'Read', tool_detail: 'x' }); f.event('stop', 15);
  const round = roundOf(read(f, [1, 2]), 1);
  assert.equal(round.state, 'stopped'); assert.equal(round.end, at(8));
  assert.equal(round.segments.reduce((sum, part) => sum + part.steps.length, 0), 0);
});

test('the delivery of a message after more than a page of boundaries is still found', t => {
  const f = fixture(t, { now: at(5000) });
  f.event('stop', 0);
  f.event('user_prompt_submit', 1); f.deliver(900, 1.2);
  f.bulk(() => { for (let i = 0; i < 1100; i++) f.deliver(1000 + i, 2 + i * 0.5); });
  f.message(1, 600); f.deliver(1, 600.2);
  f.tool('mine', 601, 602, { tool_name: 'Read', tool_detail: 'm' });
  f.event('stop', 610);
  const result = read(f, [1]);
  assert.equal(result.items[0].state, 'round');
  const round = roundOf(result, 1);
  assert.equal(round.start, at(600.2)); assert.equal(round.end, at(610));
  assert.deepEqual(toolSteps(round.segments[0]).map(step => step.label.arg), ['m']);
});

test('a message sent during a turn that began long before it starts its round at its own delivery', t => {
  const f = fixture(t);
  f.event('stop', 0);
  f.deliver(900, 1); f.event('user_prompt_submit', 1.5);
  f.tool('hidden', 2, 3, { tool_name: 'Read', tool_detail: 'h' });
  f.message(1, 100); f.deliver(1, 100.2);
  f.tool('mine', 101, 102, { tool_name: 'Read', tool_detail: 'm' });
  f.message(2, 140, 'out'); f.event('stop', 150);
  const round = roundOf(read(f, [1]), 1);
  assert.equal(round.start, at(100.2)); assert.equal(round.end, at(150));
  assert.deepEqual(toolSteps(round.segments[0]).map(step => step.label.arg), ['m']);
});

test('a reply sent after the round ended belongs to no part of it', t => {
  const f = fixture(t);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('a', 2, 3, { tool_name: 'Read', tool_detail: 'a' });
  f.message(2, 10, 'out'); f.event('stop', 12);
  f.message(3, 30, 'out');
  const round = roundOf(read(f, [1]), 1);
  assert.deepEqual(round.segments.map(part => part.replyId), [2, null]);
});

test('messages days apart each find their own round, even with more turns between them than one read covers', t => {
  const DAY = 86_400;
  const f = fixture(t, { now: at(3 * DAY) });
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('first', 2, 3, { tool_name: 'Read', tool_detail: 'first' }); f.event('stop', 5);
  f.bulk(() => { for (let i = 0; i < 5200; i++) { f.event('user_prompt_submit', 100 + i * 40); f.event('stop', 110 + i * 40); } });
  const later = 2.5 * DAY;
  f.message(2, later); f.event('user_prompt_submit', later + 0.5); f.deliver(2, later + 1);
  f.tool('second', later + 2, later + 3, { tool_name: 'Read', tool_detail: 'second' }); f.event('stop', later + 10);
  const result = read(f, [1, 2]);
  assert.deepEqual(result.items.map(item => [item.id, item.state]), [[1, 'round'], [2, 'round']]);
  assert.deepEqual([1, 2].map(id => toolSteps(roundOf(result, id).segments[0]).map(step => step.label.arg)), [['first'], ['second']]);
  assert.equal(roundOf(result, 2).start, at(later + 0.5));
});

test('a long subagent leaves the latest steps and the subagent end in view', t => {
  const f = fixture(t);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.event('pre_tool_use', 2, { meta: { tool_use_id: 'agent', tool_name: 'Agent', tool_detail: 'Dig' } });
  f.bulk(() => {
    for (let i = 0; i < 800; i++) f.tool(`inner-${i}`, 3 + i * 0.01, 3.005 + i * 0.01, { tool_name: 'Read', tool_detail: 'x', agent_id: 'sub-1' });
  });
  f.event('post_tool_use', 20, { meta: { tool_use_id: 'agent', tool_name: 'Agent', tool_detail: 'Dig' } });
  f.tool('last', 21, 22, { tool_name: 'Read', tool_detail: 'latest' });
  f.event('stop', 25);
  const round = roundOf(read(f, [1]), 1);
  assert.deepEqual(toolSteps(round.segments[0]).map(step => [step.label.key, step.label.arg, step.status]),
    [['subagent', 'Dig', 'done'], ['read', 'latest', 'done']]);
  assert.equal(round.segments.some(part => part.truncated), false);
});

test('a round with more steps than it can show keeps the newest and marks the part that lost older ones', t => {
  const f = fixture(t);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.bulk(() => { for (let i = 0; i < 800; i++) f.tool(`s${i}`, 2 + i * 0.1, 2.05 + i * 0.1, { tool_name: 'Read', tool_detail: `f${i}` }); });
  f.message(2, 90, 'out'); f.event('stop', 91);
  const round = roundOf(read(f, [1]), 1);
  const [part, tail] = round.segments;
  const steps = toolSteps(part);
  assert.equal(steps.length, 500);
  assert.equal(steps[0].label.arg, 'f300'); assert.equal(steps.at(-1).label.arg, 'f799');
  assert.ok(steps.every(step => step.status === 'done'));
  assert.equal(part.truncated, true); assert.equal(tail.truncated, undefined);
});

test('Codex exec is a command and multi-agent controls of both generations are not steps', t => {
  const f = fixture(t);
  const codex = { runtime: 'codex', session: 'thread-1' };
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0, codex);
  f.event('tool_call', 1, { ...codex, meta: { call_id: 'e1', tool_name: 'exec' } });
  f.event('tool_result', 2, { ...codex, meta: { call_id: 'e1', tool_name: 'exec', outcome: 'failed' } });
  ['send_message', 'list_agents', 'followup_task', 'interrupt_agent', 'wait', 'sleep', 'resume_agent'].forEach((name, index) => {
    f.event('tool_call', 3 + index, { ...codex, meta: { call_id: `c${index}`, tool_name: name } });
    f.event('tool_result', 3.5 + index, { ...codex, meta: { call_id: `c${index}`, tool_name: name, outcome: 'succeeded' } });
  });
  f.event('turn_complete', 12, codex);
  const round = roundOf(read(f, [1]), 1);
  assert.deepEqual(round.segments[0].steps.map(step => `${step.label.key}:${step.status}`), ['runCommand:failed']);
});

test('a round is still settling fifteen seconds after its end and settled after twenty', t => {
  const f = fixture(t, { now: at(35) });
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('read', 2, null, { tool_name: 'Read', tool_detail: 'a' });
  f.message(2, 18, 'out'); f.event('stop', 20);
  let round = roundOf(read(f, [1]), 1);
  assert.equal(round.settling, true, 'two collector cycles after the continuation gap have not passed yet');
  assert.equal(toolSteps(round.segments[0])[0].status, 'running');
  f.clock.now = at(40.5);
  round = roundOf(read(f, [1]), 1);
  assert.equal(round.settling, undefined);
  assert.equal(toolSteps(round.segments[0])[0].status, 'incomplete');
});

test('a round whose events alone reach the read limit is marked as missing older steps', t => {
  const f = fixture(t);
  const codex = { runtime: 'codex', session: 'thread-1' };
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0, codex);
  f.event('tool_call', 1, { ...codex, meta: { call_id: 'first', tool_name: 'exec_command' } });
  f.event('tool_result', 1.5, { ...codex, meta: { call_id: 'first', tool_name: 'exec_command', outcome: 'succeeded' } });
  // Agent controls are no steps, but each is an event: 1,600 of them fill the read on their own.
  f.bulk(() => { for (let i = 0; i < 1600; i++) f.event('tool_call', 2 + i * 0.01, { ...codex, meta: { call_id: `w${i}`, tool_name: 'wait_agent' } }); });
  f.event('tool_call', 30, { ...codex, meta: { call_id: 'late', tool_name: 'exec_command' } });
  f.event('tool_result', 31, { ...codex, meta: { call_id: 'late', tool_name: 'exec_command', outcome: 'succeeded' } });
  f.event('turn_complete', 40, codex);
  const round = roundOf(read(f, [1]), 1);
  const steps = round.segments.flatMap(toolSteps);
  assert.equal(steps.length, 1, 'only the newest step fits after the controls');
  assert.equal(steps[0].start, at(30));
  assert.equal(round.segments.find(part => part.steps.length).truncated, true, 'far fewer steps than the per-round limit, yet older ones were cut');
});

test('a message whose turn was still open where a long read stopped gets a read of its own', t => {
  const f = fixture(t, { now: at(1_000_000) });
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1); f.event('stop', 5);
  // 3 + 9,980 + 2 + 15 boundaries: the first read (10 pages of 1,000) ends inside the turn of message 2.
  f.bulk(() => { for (let i = 0; i < 4990; i++) { f.event('user_prompt_submit', 100 + i * 40); f.event('stop', 110 + i * 40); } });
  const later = 100 + 4990 * 40 + 100;
  f.message(2, later); f.event('user_prompt_submit', later + 0.5); f.deliver(2, later + 1);
  f.bulk(() => { for (let i = 0; i < 15; i++) f.deliver(900 + i, later + 2 + i); });
  f.tool('second', later + 20, later + 21, { tool_name: 'Read', tool_detail: 'second' });
  f.event('stop', later + 30);
  const result = read(f, [1, 2]);
  const round = roundOf(result, 2);
  assert.equal(round.key, '2');
  assert.equal(round.state, 'done', 'its end lies beyond the first read and is found by its own');
  assert.equal(round.end, at(later + 30));
  assert.deepEqual(toolSteps(round.segments[0]).map(step => step.label.arg), ['second']);
});

test('an interrupt that never reached the session is not a moment the group was idle', t => {
  const f = fixture(t);
  f.event('user_prompt_submit', -20); f.event('stop', -10);
  f.message(1, 0); f.event('user_prompt_submit', 0); f.deliver(1, 0.2);
  f.tool('job', 2, 100, { tool_name: 'Bash', tool_detail: 'Long job', detail_source: 'description' });
  f.event('dashboard_interrupt', 30, { session: null, meta: { control_id: 9 } });
  f.control(9, 'failed', 31);
  f.message(2, 60); f.deliver(2, 60.2);
  f.message(3, 110, 'out'); f.event('stop', 120);
  const result = read(f, [2]);
  assert.deepEqual(result.items.map(item => [item.id, item.state]), [[2, 'round']]);
  const round = roundOf(result, 2);
  assert.equal(round.key, '1', 'message 2 arrived during the turn of message 1 and joins its round');
  assert.equal(round.start, at(0)); assert.equal(round.state, 'done');
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

const codex = { runtime: 'codex', session: 'thread-1' };
const steps = round => round.segments.flatMap(segment => segment.steps);
const describe = round => steps(round).map(step => `${step.kind}:${step.label.key}:${step.status}`);
const timeOf = (lines, match) => Date.parse(lines.find(match).timestamp);
const PRIVATE = ['<redacted', 'zylo131', 'plan_audit', 'single_session', 'Kierkegaard', V1_CHILD, '"hi"'];
function assertNothingPrivate(round, name) {
  const shown = JSON.stringify(round);
  for (const secret of PRIVATE) assert.ok(!shown.includes(secret), `${name}: ${secret} is not shown`);
}
// A round opened by message 1 at 0 s, with recorded Codex lines collected from its rollout; the reply arrives after.
async function codexRound(t, lines, { replyAt = 30, child = null, childPasses = 1, ended = true } = {}) {
  const f = fixture(t);
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0, codex);
  await collectRollout(f, 'parent', lines);
  if (child) await collectRollout(f, 'child', child, { passes: childPasses });
  if (ended) { f.message(2, replyAt, 'out'); if (!lines.some(line => line.payload?.type === 'task_complete')) f.event('turn_complete', replyAt + 1, codex); }
  return { f, round: roundOf(read(f, [1]), 1) };
}

test('a Codex v2 subtask is one step from its recorded start to its recorded completion, never a command or its message', async t => {
  const lines = v2CompletedTurn(at(1));
  const { round } = await codexRound(t, lines);
  assert.deepEqual(describe(round), ['subagent:subagent:done'], 'the spawn answer and its start event make one step');
  const [step] = steps(round);
  assert.equal(step.start, timeOf(lines, line => line.payload.item?.kind === 'started'), 'starts at the recorded start');
  assert.equal(step.end, timeOf(lines, line => line.payload.item?.kind === 'completed'), 'a timed-out wait does not end it');
  assertNothingPrivate(round, 'v2');
});

test('a Codex v2 subtask that was interrupted shows as stopped where it was interrupted', async t => {
  const lines = v2InterruptedTurn(at(1));
  const { round } = await codexRound(t, lines);
  assert.deepEqual(describe(round), ['subagent:subagent:stopped']);
  assert.equal(steps(round)[0].end, Date.parse(lines.at(-1).timestamp));
  assertNothingPrivate(round, 'v2 interrupted');
});

test('a Codex v2 wait that timed out leaves the subtask running until its round ends', async t => {
  const lines = v2TimedOutTurn(at(1));
  const live = await codexRound(t, lines, { ended: false });
  live.f.clock.now = at(20);
  const running = roundOf(read(live.f, [1]), 1);
  assert.deepEqual(describe(running), ['subagent:subagent:running'], 'still running after the timed-out wait');
  const { round } = await codexRound(t, lines, { replyAt: 30 });
  assert.equal(steps(round)[0].end, at(31), 'it ends with its round, not at the timed-out wait');
});

test('a Codex v1 subtask run from code mode is one step, not two commands, ending once at its wait result', async t => {
  const lines = v1ParentTurn(at(1));
  const { round } = await codexRound(t, lines);
  assert.deepEqual(describe(round), ['subagent:subagent:done']);
  const [step] = steps(round);
  assert.equal(step.start, timeOf(lines, line => line.payload.call_id === V1_SPAWN_EXEC && line.payload.type === 'custom_tool_call_output'));
  assert.equal(step.end, timeOf(lines, line => line.payload.call_id === V1_WAIT_EXEC && line.payload.type === 'custom_tool_call_output'),
    'the completion notice right after does not end it a second time');
  assert.equal(round.end, timeOf(lines, line => line.payload.type === 'task_complete'));
  assertNothingPrivate(round, 'v1');
});

test('a Codex v1 subtask whose script printed nothing is named by the thread Codex reported spawning', async t => {
  const lines = v1ParentTurn(at(1)).map(line => {
    if (line.payload.type !== 'custom_tool_call_output') return line;
    return { ...line, payload: { ...line.payload, output: [line.payload.output[0]] } };
  });
  const { round } = await codexRound(t, lines);
  assert.deepEqual(describe(round), ['subagent:subagent:done']);
  assert.equal(steps(round)[0].end, timeOf(lines, line => line.payload.type === 'message'), 'the completion notice ends it');
});

test('a Codex subagent thread rollout that names its parent as the session neither ends the parent round nor adds steps', async t => {
  const parent = v1ParentTurn(at(1));
  const { f, round } = await codexRound(t, parent, { child: v1ChildRollout(at(1)) });
  assert.deepEqual(describe(round), ['subagent:subagent:done']);
  assert.equal(round.end, timeOf(parent, line => line.payload.type === 'task_complete'), 'the child turn end is not the parent turn end');
  const childUsage = f.store.db.prepare("SELECT COUNT(*) FROM metric_points WHERE metric_name = 'turn_duration'").pluck().get();
  assert.equal(childUsage, 2, 'both threads keep their turn timing');
});

test('a long Codex subagent thread rollout read over several passes still neither ends the parent round nor adds steps', async t => {
  const parent = v1ParentTurn(at(1)), child = v1LongChildRollout(at(1));
  assert.ok(Buffer.byteLength(child.map(line => JSON.stringify(line)).join('\n')) > 256 * 1024, 'longer than one read');
  const { f, round } = await codexRound(t, parent, { child, childPasses: 3 });
  assert.equal(f.store.db.prepare('SELECT byte_offset FROM codex_rollout_cursors WHERE transcript_path LIKE ?').pluck().get('%child.jsonl'),
    fs.statSync(path.join(f.root, 'child.jsonl')).size, 'the child rollout was read to its end');
  assert.deepEqual(describe(round), ['subagent:subagent:done'], 'its command, read in a later pass, is not a parent step');
  assert.equal(round.end, timeOf(parent, line => line.payload.type === 'task_complete'), 'nor is its turn end the parent turn end');
});

test('a code-mode command that yields stays one running step until a wait on its cell sees it finish', async t => {
  const lines = codeModeYieldedCommand(at(1));
  const live = await codexRound(t, lines.slice(0, 4), { ended: false });
  live.f.clock.now = at(25);
  assert.deepEqual(describe(roundOf(read(live.f, [1]), 1)), ['tool:runCommand:running'], 'yielded and still running after a wait');
  const { round } = await codexRound(t, lines);
  assert.deepEqual(describe(round), ['tool:runCommand:done'], 'the waits on its cell are not steps of their own');
  assert.equal(steps(round)[0].end, Date.parse(lines.at(-1).timestamp), 'it ends when a wait reports the script finished');
  const failed = await codexRound(t, codeModeYieldedCommand(at(1), { exitCode: 1 }));
  assert.deepEqual(describe(failed.round), ['tool:runCommand:failed'], 'the finishing output decides whether it failed');
});

test('a Codex v1 subtask whose wait yielded ends when a wait on that cell reads its result', async t => {
  const lines = v1YieldedWaitTurn(at(1)).filter(line => line.payload.type !== 'message');
  const { round } = await codexRound(t, lines);
  assert.deepEqual(describe(round), ['subagent:subagent:done']);
  assert.equal(steps(round)[0].end, timeOf(lines, line => line.payload.call_id === 'call_cell_wait' && line.payload.type === 'function_call_output'));
  assertNothingPrivate(round, 'v1 yielded wait');
});

test('a Codex subtask whose finish was never recorded ends with its round instead of reading as unfinished', t => {
  const f = fixture(t);
  const codex = { runtime: 'codex', session: 'thread-1' };
  f.message(1, 0); f.deliver(1, 0.2); f.event('user_prompt_submit', 0, codex);
  f.event('subagent_start', 2, { ...codex, meta: { agent_id: '/root/inspect_logs' } });
  f.event('tool_call', 3, { ...codex, meta: { call_id: 'c1', tool_name: 'exec_command' } });
  f.message(2, 15, 'out'); f.event('turn_complete', 16, codex);
  const steps = roundOf(read(f, [1]), 1).segments[0].steps;
  assert.deepEqual(steps.map(step => [step.label.key, step.status, step.end]), [['subagent', 'done', at(16)], ['runCommand', 'incomplete', at(16)]]);
});

test('a Dashboard database one version older gains the group, type and time index, and activity lookups use it', t => {
  const f = fixture(t);
  const db = f.store.db;
  db.exec('DROP INDEX idx_events_group_type_ts; DELETE FROM schema_migrations WHERE version=27');
  migrateDatabase(db);
  assert.equal(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), TARGET_SCHEMA_VERSION);
  assert.deepEqual(db.pragma('index_info(idx_events_group_type_ts)').map(column => column.name), ['session_group', 'event_type', 'timestamp']);
  f.message(1, 0); f.event('user_prompt_submit', 0.5); f.deliver(1, 1);
  f.tool('a', 2, 3, { tool_name: 'Read', tool_detail: 'a' }); f.event('stop', 5);
  const seen = [], prepare = db.prepare.bind(db);
  db.prepare = sql => { seen.push(sql); return prepare(sql); };
  try { read(f, [1]); } finally { db.prepare = prepare; }
  const lookups = seen.filter(sql => /FROM runtime_events WHERE session_group=@group\s+AND event_type IN/.test(sql));
  assert.ok(lookups.length >= 3, 'idle point, boundaries and steps');
  for (const sql of lookups) {
    const parameters = Object.fromEntries([...sql.matchAll(/@(\w+)/g)].map(([, name]) => [name, name === 'seq' ? 0 : 'x']));
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameters).map(row => row.detail).join(' | ');
    assert.match(plan, /USING INDEX idx_events_group_type_ts/, sql.slice(0, 80));
  }
});
