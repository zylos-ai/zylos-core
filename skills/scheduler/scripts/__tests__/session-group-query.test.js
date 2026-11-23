import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTask } from '../daemon-dispatch.js';
import { schedulerQueryFixture } from '../../../../test/helpers/scheduler-query-fixture.js';

const pair = task => [task.session_component, task.session_group_name];
const delivery = (f, sendViaC4 = () => ({ category: 'success' })) => ({ ...f.deps, sendViaC4 });

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

test('query failure dispatches overall without saving, preserves its history warning on receipt and retries next time', t => {
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
  assert.equal(f.read(task.id).status, 'completed');
  assert.equal(currentHistory().status, 'success');
  f.cliData(['done', task.id]);
  assert.equal(currentHistory().status, 'success'); assert.equal(currentHistory().error, 'SESSION_GROUP_QUERY_FAILED');
  f.db.prepare("UPDATE tasks SET status='pending' WHERE id=?").run(task.id);
  f.install({ 'chat-old': { output: 'recovered\n' } });
  dispatchTask(f.db, f.read(task.id), delivery(f));
  assert.equal(f.queries().length, 2); assert.deepEqual(pair(f.read(task.id)), ['telegram', 'recovered']);
});
