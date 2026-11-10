import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTask } from '../daemon-dispatch.js';
import { schedulerQueryFixture } from '../../../../test/helpers/scheduler-query-fixture.js';

const route = endpoint => ['--reply-channel', 'telegram', '--reply-endpoint', endpoint];
const pair = task => [task.session_component, task.session_group_name];
const delivery = (f, sendViaC4 = () => ({ category: 'success' })) => ({ ...f.deps, sendViaC4 });

// Boundary: actual CLI -> shared synchronous query process -> private scheduler
// DB. Run for add/update/query contract changes; UI-only changes may skip.
// The fixture logs private HOME/ZYLOS_DIR/PM2_HOME/temp/socket/DB paths before any
// child launch, uses no PM2/tmux, and reaps bounded synchronous children/DB roots.
test('reply destinations query once on add and endpoint update without allocating namespaces', t => {
  const f = schedulerQueryFixture(t);
  f.install({ first: { output: 'topic-first\n' }, second: { output: 'topic-second\r\n' } });
  const task = f.add(route('first'));
  assert.deepEqual(pair(task), ['telegram', 'topic-first']);
  assert.equal(f.queries().length, 1);
  const updated = f.cliData(['update', task.id, '--reply-endpoint', 'second']).task;
  assert.deepEqual(pair(updated), ['telegram', 'topic-second']);
  assert.equal(updated.reply_endpoint, 'second');
  assert.deepEqual(f.queries().map(row => row.endpoint), ['first', 'second']);
  const query = f.queries()[0];
  assert.equal(query.HOME, f.env.HOME); assert.equal(query.ZYLOS_DIR, f.env.ZYLOS_DIR);
  assert.equal(query.PM2_HOME, f.env.PM2_HOME); assert.equal(query.TMPDIR, f.env.TMPDIR);
  assert.equal(query.cwd, f.skills + '/telegram');
  assert.equal(f.c4.prepare('SELECT count(*) n FROM channel_namespaces').get().n, 0);
  assert.equal(f.c4.prepare('SELECT count(*) n FROM conversations').get().n, 0);
  const explicit = f.add([...route('first'), '--reply-session-group', 'explicit']);
  assert.deepEqual(pair(explicit), ['telegram', 'explicit']);
  const changed = f.cliData(['update', explicit.id, ...route('second'), '--reply-session-group', 'other']).task;
  assert.deepEqual(pair(changed), ['telegram', 'other']);
  assert.equal(f.queries().length, 2, 'explicit groups bypass query');
});

test('missing query script and empty output save overall groups', t => {
  const f = schedulerQueryFixture(t);
  assert.deepEqual(pair(f.add(route('missing-script'))), ['telegram', null]);
  assert.equal(f.queries().length, 0);
  f.install({ empty: { output: '' }, newline: { output: '\n' } });
  assert.deepEqual(pair(f.add(route('empty'))), ['telegram', null]);
  assert.deepEqual(pair(f.add(route('newline'))), ['telegram', null]);
  assert.equal(f.queries().length, 2);
});

for (const [label, answer] of [['nonzero', { exit: 3, stderr: 'query fixture failed' }],
  ['invalid output', { output: ' topic\n' }], ['overflow', { output: 'a'.repeat(4097) }]]) {
  test(`query ${label} rejects add and update without changing the task`, t => {
    const f = schedulerQueryFixture(t); f.install({ broken: answer });
    const task = f.add([...route('kept'), '--reply-session-group', 'kept']);
    const before = f.read(task.id), count = f.db.prepare('SELECT count(*) n FROM tasks').get().n;
    for (const args of [['add', 'rejected', '--in', '1 hour', ...route('broken')],
      ['update', task.id, '--priority', '1', '--reply-endpoint', 'broken']]) {
      const result = f.run(args); assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, 'SESSION_GROUP_QUERY_FAILED');
      assert.deepEqual(f.read(task.id), before);
      assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, count);
    }
  });
}

test('fixed Dashboard Origin saves no group and rejects explicit names before querying', t => {
  const f = schedulerQueryFixture(t); f.install({}, 'dashboard', { exit: 9 });
  const task = f.add(['--reply-channel', 'dashboard', '--reply-endpoint', 'origin']);
  assert.deepEqual(pair(task), [null, null]);
  for (const group of ['name', '', 'bad name']) {
    for (const args of [['add', 'invalid origin', '--in', '1 hour', '--reply-channel', 'dashboard', '--reply-endpoint', 'origin'],
      ['update', task.id, '--reply-channel', 'dashboard']]) {
      const result = f.run([...args, '--reply-session-group', group]);
      assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGS');
    }
  }
  assert.deepEqual(pair(f.read(task.id)), [null, null]); assert.equal(f.queries().length, 0);
  const regular = f.add([...route('regular'), '--reply-session-group', 'kept']);
  const updated = f.cliData(['update', regular.id, '--reply-channel', 'dashboard', '--reply-endpoint', 'origin']).task;
  assert.deepEqual(pair(updated), [null, null]); assert.equal(f.queries().length, 0);
});

// Boundary: real dispatch claim/query/CAS + receiver process -> private C4 D1.
// Run for dispatch/group/receive changes; unrelated CLI display changes may skip.
// Query scripts are fixture components; the shared query implementation and C4
// receiver are real, with private databases and no AM/PM2/tmux/live channel.
test('first legacy dispatch saves its queried group and later executions do not query again', t => {
  const f = schedulerQueryFixture(t); f.install({ 'chat-old': { output: 'new-group\n' } });
  const task = f.legacy();
  const first = dispatchTask(f.db, task, f.deps); assert.equal(first.claimed, true);
  assert.deepEqual(pair(f.read(task.id)), ['telegram', 'new-group']);
  assert.equal(f.queries().length, 1);
  const inbound = f.c4.prepare("SELECT * FROM conversations WHERE direction='in'").all();
  assert.equal(inbound.length, 1); assert.equal(inbound[0].session_group, 'telegram:new-group');
  f.cliData(['done', task.id]);
  f.db.prepare("UPDATE tasks SET status='pending' WHERE id=?").run(task.id);
  dispatchTask(f.db, f.read(task.id), f.deps);
  assert.equal(f.queries().length, 1);
  assert.equal(f.c4.prepare("SELECT count(*) n FROM conversations WHERE direction='in' AND session_group='telegram:new-group'").get().n, 2);
});

test('saved overall groups and legacy channel-only routes do not query', t => {
  const f = schedulerQueryFixture(t); f.install({}, 'telegram', { exit: 9 });
  for (const shape of [{ session_component: 'telegram', session_group_name: null }, { reply_endpoint: null }]) {
    const task = f.legacy(shape); let actual;
    dispatchTask(f.db, task, { ...f.deps, sendViaC4: (message, destination) => { actual = destination; return f.send(message, destination); } });
    assert.equal(actual.sessionGroupName, null);
    assert.equal(actual.replyChannel, 'telegram');
  }
  assert.equal(f.queries().length, 0);
  const inbound = f.c4.prepare("SELECT session_group FROM conversations WHERE direction='in' ORDER BY id").all();
  assert.equal(inbound.length, 2); assert.deepEqual(inbound.map(row => row.session_group), ['telegram', 'telegram']);
});

test('fixed Origin and no-address destinations reach Origin without querying', t => {
  const f = schedulerQueryFixture(t); f.install({}, 'dashboard', { exit: 9 });
  const fixed = f.legacy({ reply_channel: 'dashboard', reply_endpoint: 'origin' });
  dispatchTask(f.db, fixed, f.deps);
  assert.deepEqual(pair(f.read(fixed.id)), [null, null]);
  const savedFixed = f.legacy({ reply_channel: 'dashboard', reply_endpoint: 'origin',
    session_component: 'dashboard', session_group_name: 'obsolete' });
  dispatchTask(f.db, savedFixed, f.deps);
  assert.deepEqual(pair(f.read(savedFixed.id)), ['dashboard', 'obsolete'], 'fixed routing ignores legacy groups without rewriting them');
  const plain = f.add(); dispatchTask(f.db, plain, f.deps);
  assert.equal(f.queries().length, 0);
  const inbound = f.c4.prepare("SELECT * FROM conversations WHERE direction='in' ORDER BY id").all();
  assert.equal(inbound.length, 3);
  assert.deepEqual(inbound.map(row => row.session_group), ['origin', 'origin', 'origin']);
  assert.equal(inbound[0].channel, 'dashboard'); assert.equal(inbound[0].endpoint_id, 'origin');
  assert.equal(inbound[2].channel, 'system'); assert.equal(inbound[2].endpoint_id, null);
});

test('query failure dispatches overall without saving, preserves warning through done and retries next time', t => {
  const f = schedulerQueryFixture(t); f.install({}, 'telegram', { exit: 4, stderr: 'fixture query failure' });
  const task = f.legacy({ last_error: 'prior-task-detail' }); const logs = [];
  f.db.prepare("INSERT INTO task_history(task_id,executed_at,status,error) VALUES(?,0,'failed','prior-history-detail')").run(task.id);
  const currentHistory = () => f.history(task.id).at(-1);
  let actual;
  const result = dispatchTask(f.db, task, { ...delivery(f, (message, destination) => {
    actual = destination;
    assert.equal(currentHistory().error, 'SESSION_GROUP_QUERY_FAILED', 'warning is recorded before delivery');
    assert.equal(currentHistory().status, 'started');
    assert.equal(f.history(task.id)[0].error, 'prior-history-detail');
    return f.send(message, destination);
  }), diagnostic: message => logs.push(message) });
  assert.equal(result.category, 'success'); assert.equal(actual.sessionComponent, 'telegram'); assert.equal(actual.sessionGroupName, null);
  assert.deepEqual(pair(f.read(task.id)), [null, null]); assert.equal(f.read(task.id).last_error, 'prior-task-detail');
  assert.equal(f.c4.prepare("SELECT session_group FROM conversations WHERE direction='in'").get().session_group, 'telegram');
  assert.equal(logs.length, 1); assert.match(logs[0], /SESSION_GROUP_QUERY_FAILED/); assert.match(logs[0], /fixture query failure/);
  f.cliData(['done', task.id]);
  assert.equal(currentHistory().status, 'success'); assert.equal(currentHistory().error, 'SESSION_GROUP_QUERY_FAILED');
  f.db.prepare("UPDATE tasks SET status='pending' WHERE id=?").run(task.id);
  f.install({ 'chat-old': { output: 'recovered\n' } });
  dispatchTask(f.db, f.read(task.id), delivery(f));
  assert.equal(f.queries().length, 2); assert.deepEqual(pair(f.read(task.id)), ['telegram', 'recovered']);
});

for (const category of ['C', 'U', 'T', 'R']) test(`delivery ${category} error overrides the query warning`, t => {
  const f = schedulerQueryFixture(t); f.install({}, 'telegram', { exit: 4 });
  const task = f.legacy(); const code = 'DELIVERY_' + category;
  const deps = { ...delivery(f, () => ({ category, code })), diagnostic: () => {},
    getConversationsByRange: () => { throw new Error('readback unavailable'); } };
  dispatchTask(f.db, task, deps);
  const expected = category === 'U' ? 'RECEIVE_RESULT_UNKNOWN' : code;
  assert.equal(f.history(task.id)[0].error, expected);
  assert.equal(f.read(task.id).last_error, expected);
  assert.deepEqual(pair(f.read(task.id)), [null, null]);
});

for (const edit of ['reply route', 'saved group']) test(`concurrent ${edit} edit makes CAS miss but dispatch keeps the claimed route and queried group`, t => {
  const f = schedulerQueryFixture(t); f.install({ 'chat-old': { output: 'old-group\n' } });
  const task = f.legacy({ last_error: 'unchanged' }); let actual; const logs = [];
  dispatchTask(f.db, task, { ...delivery(f, (_message, destination) => { actual = destination; return { category: 'success' }; }),
    query(target) {
      const answer = f.query(target);
      if (edit === 'reply route') f.db.prepare("UPDATE tasks SET reply_endpoint='changed' WHERE id=?").run(task.id);
      else f.db.prepare("UPDATE tasks SET session_component='telegram',session_group_name='changed-group' WHERE id=?").run(task.id);
      return answer;
    }, diagnostic: message => logs.push(message) });
  assert.equal(f.queries().length, 1); assert.equal(actual.replyEndpoint, 'chat-old'); assert.equal(actual.sessionGroupName, 'old-group');
  assert.equal(f.read(task.id).reply_endpoint, edit === 'reply route' ? 'changed' : 'chat-old');
  assert.deepEqual(pair(f.read(task.id)), edit === 'reply route' ? [null, null] : ['telegram', 'changed-group']);
  assert.equal(f.read(task.id).last_error, 'unchanged'); assert.equal(f.history(task.id)[0].error, null); assert.equal(logs.length, 0);
});

test('database writeback error logs once and dispatches queried group without altering last_error', t => {
  const f = schedulerQueryFixture(t); f.install({ 'chat-old': { output: 'queried\n' } });
  const task = f.legacy({ last_error: 'unchanged' }); const logs = []; let actual;
  f.db.exec("CREATE TRIGGER refuse_group BEFORE UPDATE OF session_component ON tasks BEGIN SELECT RAISE(ABORT,'fixture writeback blocked'); END");
  dispatchTask(f.db, task, { ...delivery(f, (_message, destination) => { actual = destination; return { category: 'success' }; }), diagnostic: message => logs.push(message) });
  assert.deepEqual(pair(f.read(task.id)), [null, null]); assert.equal(actual.sessionGroupName, 'queried');
  assert.equal(f.read(task.id).last_error, 'unchanged'); assert.equal(f.history(task.id)[0].error, null);
  assert.equal(logs.length, 1); assert.ok(logs[0].includes(task.id)); assert.match(logs[0], /fixture writeback blocked/);
  f.cliData(['done', task.id]); f.db.prepare("UPDATE tasks SET status='pending' WHERE id=?").run(task.id);
  dispatchTask(f.db, f.read(task.id), { ...delivery(f), diagnostic: () => {} });
  assert.equal(f.queries().length, 2);
});
