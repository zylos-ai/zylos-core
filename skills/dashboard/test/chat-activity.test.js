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
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';

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
  t.after(() => { reader.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, store, history, activity, message, event, deliver, tool, clock };
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
  f.event('dashboard_interrupt', 15, { session: null });
  const result = read(f, [1, 2]);
  const first = roundOf(result, 1), second = roundOf(result, 2);
  assert.deepEqual(toolSteps(first.segments[0]).map(step => step.status), ['failed', 'incomplete']);
  assert.equal(first.state, 'done');
  assert.equal(second.state, 'stopped'); assert.equal(second.end, at(15));
  assert.deepEqual(toolSteps(second.segments[0]).map(step => [step.status, step.end]), [['stopped', at(15)]]);
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
    ['runCommand::failed', 'edit:b/c/d.md:done', 'subagent:Look at logs:done', 'say']);
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
