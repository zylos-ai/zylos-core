import test from 'node:test';
import assert from 'node:assert/strict';
import { answerDeliveryFixture } from './helpers/answer-delivery-fixture.js';
import { dataError } from '../../comm-bridge/scripts/c4-session-group.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { receive } from '../../comm-bridge/scripts/c4-receive.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

// Real Dashboard acceptance/conditional transaction, real temporary C4 store,
// readonly reconciliation and real in-process receive; only route/status notice
// adapters are fixture-owned. Run for answer acceptance, send classification or
// recovery changes; unrelated UI-only changes may skip. Official runner isolates
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR before imports; every case closes both DBs
// and the readonly handle. No CLI, runtime, network, PM2, tmux or timer is started.

const deliveryRow = (f, id) => f.store.db.prepare('SELECT * FROM chat_answer_deliveries WHERE answer_id=?').get(id);
const mark = (f, id, state, c4Id = null) => f.store.db.prepare('UPDATE chat_answer_deliveries SET state=?,c4_id=? WHERE answer_id=?').run(state, c4Id, id);
const insertAnswer = (f, answer, { direction = 'in', channel = 'dashboard', group = answer.endpointId, endpoint = group, content = answer.content } = {}) =>
  f.c4.insertConversation(direction, channel, endpoint, content, { groupName: group });

function assertCommitted(receipt) {
  assert.equal(receipt.stored, true);
  assert.equal(receipt.retryAllowed, false);
}

test('accepted answer and pending delivery commit before receive, then saved row state is authoritative', async t => {
  const f = answerDeliveryFixture(t), { answer, created } = f.accept();
  assert.equal(created, true);
  assert.equal(deliveryRow(f, answer.answerId).state, 'pending');
  f.setInvoke(async args => {
    assert.equal(f.store.db.inTransaction, false);
    assert.equal(f.answers.get(answer.answerId).answerId, answer.answerId);
    assert.equal(deliveryRow(f, answer.answerId).state, 'sending');
    return f.realReceive(args);
  });
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assertCommitted(sent);
  assert.equal(sent.deliveryState, 'pending');
  assert.equal(sent.messageId, f.answerRows(answer.answerId)[0].id);
  assert.equal(deliveryRow(f, answer.answerId).c4_id, sent.messageId);
  const envelope = parseC4Content(f.answerRows(answer.answerId)[0].content).envelope;
  assert.equal(envelope.questionSummary, '选一个方案');
  assert.equal(envelope.metadata.zylos.answerId, answer.answerId);
  assert.equal(f.counts.receive, 1);
  await f.delivery.deliver(answer.answerId);
  await f.delivery.deliver(answer.answerId, { retry: true });
  assert.equal(f.counts.receive, 1, 'ordinary duplicate and explicit retry both reuse a committed answer');
});

test('after startup a blocked receive remains single-call during duplicate submissions and refresh', { timeout: 3000 }, async t => {
  const f = answerDeliveryFixture(t);
  await f.delivery.recover();
  const { answer } = f.accept();
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.setInvoke(async args => {
    if (f.counts.receive > 1) throw Error('fixture duplicate receive');
    entered(); await barrier; return f.realReceive(args);
  });
  const pending = f.delivery.deliver(answer.answerId, { initial: true });
  try {
    await Promise.race([started, pending.then(() => { throw Error('fixture receive did not block'); })]);
    for (const operation of [() => f.delivery.deliver(answer.answerId, { retry: true }),
      () => f.delivery.reconcileGroup(answer.sessionGroup), () => f.delivery.reconcile(answer.answerId),
      () => f.delivery.recover()]) {
      await operation();
      assert.equal(f.counts.receive, 1);
      assert.equal(deliveryRow(f, answer.answerId).state, 'sending');
    }
    const duplicate = f.delivery.receipt(answer.answerId);
    assert.equal(duplicate.stored, null);
    assert.equal(duplicate.needsReconciliation, true);
    assert.equal(duplicate.retryAllowed, false);
  } finally { release(); await pending; }
  assertCommitted(f.delivery.receipt(answer.answerId));
  assert.equal(f.answerRows(answer.answerId).length, 1);
});

for (const [status, action, expected] of [
  ['pending', null, 'pending'], ['running', null, 'running'], ['delivered', null, 'delivered'],
  ['failed', 'auth_rejected', 'auth_rejected'], ['failed', 'suppressed', 'suppressed'],
  ['failed', 'delivered', 'failed'], ['failed', 'other_failure', 'failed'], ['switch_absorbed', null, 'switch_absorbed'],
]) test(`existing ${status}/${action ?? 'none'} inbound is reused without another receive`, async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  const row = insertAnswer(f, answer);
  f.db.prepare('UPDATE conversations SET status=?,delivery_action=? WHERE id=?').run(status, action, row.id);
  const recovered = await f.delivery.deliver(answer.answerId, { initial: true, retry: true });
  assertCommitted(recovered);
  assert.equal(recovered.messageId, row.id);
  assert.equal(recovered.deliveryState, expected);
  assert.equal(f.counts.receive, 0);
  assert.equal(f.answerRows(answer.answerId).length, 1);
});

test('successful action delivered cannot override the stored failed inbound status', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  f.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'fixture' });
  f.setNotification('sent');
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assertCommitted(sent);
  assert.equal(sent.deliveryState, 'failed');
  assert.equal(f.answerRows(answer.answerId)[0].status, 'failed');
  assert.equal(f.counts.notifications, 1);
});

for (const notification of ['suppressed', 'failed', 'uncertain']) test(`committed ${notification} notification cannot cause an answer resend`, async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  f.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'fixture' });
  f.setNotification(notification);
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assertCommitted(sent);
  assert.equal(sent.deliveryState, notification === 'suppressed' ? 'suppressed' : 'failed');
  if (notification !== 'suppressed') assert.equal(sent.error, notification === 'failed' ? 'UNHEALTHY_NOTIFY_FAILED' : 'UNHEALTHY_NOTIFY_UNCERTAIN');
  const restarted = f.makeDelivery();
  await restarted.recover();
  assertCommitted(await restarted.deliver(answer.answerId, { retry: true }));
  assert.equal(f.counts.receive, 1);
  assert.equal(f.answerRows(answer.answerId).length, 1);
  assert.equal(parseC4Content(f.answerRows(answer.answerId)[0].content).envelope.metadata.zylos.answerId, answer.answerId);
});

test('suppression annotation write failure still retains the committed fact and blocks resending', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  f.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'fixture' });
  const broken = { ...f.c4, markStatusNoticeSuppressed() { throw Error('fixture annotation unavailable'); } };
  f.setInvoke(args => receive(args, { db: broken, queryRoute: async () => ({ decision: 'unavailable', runtime: 'claude' }),
    reserveStatusNotice: () => ({ suppressed: true }), diagnostic() {} }));
  assertCommitted(await f.delivery.deliver(answer.answerId, { initial: true }));
  await f.delivery.deliver(answer.answerId, { retry: true });
  assert.equal(f.counts.receive, 1);
  assert.equal(f.answerRows(answer.answerId).length, 1);
});

for (const failure of ['begin', 'rollback', 'validation']) test(`definite ${failure} failure preserves the accepted answer and permits an explicit retry`, async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  if (failure === 'begin') {
    const broken = new Proxy(f.db, { get(target, key) {
      if (key === 'exec') return sql => {
        if (sql === 'BEGIN IMMEDIATE') throw Object.assign(Error('fixture busy'), { code: 'SQLITE_BUSY' });
        return target.exec(sql);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const core = createStore(broken, { validateComponent: () => true });
    f.setInvoke(args => receive(args, { db: core, queryRoute: async () => ({ decision: 'pending', runtime: 'claude' }), diagnostic() {} }));
  } else if (failure === 'rollback') {
    f.db.exec("CREATE TRIGGER reject_answer BEFORE INSERT ON conversations WHEN NEW.direction='in' BEGIN SELECT RAISE(ABORT,'fixture rejects insert'); END");
  } else f.setInvoke(() => { throw dataError('INVALID_ARGS', 'fixture pre-insert validation', { persisted: [] }); });
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assert.equal(sent.stored, false);
  assert.equal(sent.needsReconciliation, false);
  assert.equal(sent.retryAllowed, true);
  assert.equal(sent.error, failure === 'begin' ? 'DB_BUSY' : failure === 'rollback' ? 'DB_WRITE_FAILED' : 'INVALID_ARGS');
  assert.equal(f.answers.get(answer.answerId).answerId, answer.answerId);
  assert.equal(f.answerRows(answer.answerId).length, 0);
  assert.equal(f.db.inTransaction, false);
  await f.delivery.deliver(answer.answerId);
  assert.equal(f.counts.receive, 1, 'repeating an action without explicit retry cannot send');
  if (failure === 'rollback') f.db.exec('DROP TRIGGER reject_answer');
  f.setInvoke(null);
  assertCommitted(await f.delivery.deliver(answer.answerId, { retry: true }));
  assert.equal(f.counts.receive, 2);
});

for (const committed of [false, true]) test(`an unknown result immediately reconciles ${committed ? 'a committed row' : 'absence'} without a restart`, async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  f.setInvoke(async args => {
    if (committed) await f.realReceive(args);
    throw dataError('INTERNAL_ERROR', 'fixture unknown commit', { persisted: null });
  });
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assert.equal(f.counts.queries, 2, 'one pre-call and one immediate post-call scoped lookup');
  assert.equal(sent.stored, committed);
  assert.equal(sent.retryAllowed, !committed);
  assert.equal(sent.needsReconciliation, false);
  assert.equal(f.counts.receive, 1);
  assert.equal(f.delivery.inflight.size, 0, 'resolve or reject ends this call');
});

test('unknown query failure stays pending and opening the group retries only lookup', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  f.setInvoke(async args => { await f.realReceive(args); f.setQueryError(true); throw Error('lost receipt'); });
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assert.equal(sent.stored, null);
  assert.equal(sent.needsReconciliation, true);
  assert.equal(sent.retryAllowed, false);
  await f.delivery.deliver(answer.answerId, { retry: true });
  assert.equal(f.counts.receive, 1);
  f.setQueryError(false);
  const opened = await f.delivery.reconcileGroup(answer.sessionGroup);
  assert.equal(opened.items.length, 1);
  assertCommitted(opened.items[0]);
  assert.equal(f.counts.receive, 1);
  assert.equal(f.answerRows(answer.answerId).length, 1);
});

test('pre-call lookup failure cannot invoke receive or infer an absent answer', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  f.setQueryError(true);
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assert.equal(sent.stored, null);
  assert.equal(sent.retryAllowed, false);
  assert.equal(sent.needsReconciliation, true);
  assert.equal(f.counts.receive, 0);
});

test('lookup scopes answer identity by group channel and inbound direction and uses the fixed parsed metadata path', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  insertAnswer(f, answer, { group: 'other-group' });
  insertAnswer(f, answer, { direction: 'out' });
  f.db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
    VALUES('in','other',?,?,?,'pending')`).run(answer.endpointId, answer.sessionGroup, answer.content);
  insertAnswer(f, answer, { content: `ordinary text contains ${answer.answerId}` });
  const misleading = structuredClone(parseC4Content(answer.content).envelope);
  misleading.action.id = 'different_answer_id'; misleading.metadata.zylos.answerId = misleading.action.id;
  misleading.fallbackText = answer.answerId;
  insertAnswer(f, answer, { content: CONTENT_PREFIX + JSON.stringify(misleading) });
  const before = f.answerRows(answer.answerId).length;
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  assertCommitted(sent);
  assert.equal(f.counts.receive, 1, 'foreign rows and textual mentions are not matches');
  assert.equal(f.answerRows(answer.answerId).length, before + 1);
});

test('two exact same-group inbound matches remain pending and never select one silently', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  insertAnswer(f, answer); insertAnswer(f, answer);
  const result = await f.delivery.deliver(answer.answerId, { initial: true, retry: true });
  assert.equal(result.stored, null);
  assert.equal(result.error, 'chat_answer_duplicate');
  assert.equal(result.needsReconciliation, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(f.counts.receive, 0);
  assert.equal(f.answerRows(answer.answerId).length, 2);
});

for (const phase of ['accepted', 'inserted', 'receipt']) test(`startup recovery after ${phase} preserves the answer and checks C4 before any retry`, async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  let existing = null;
  if (phase !== 'accepted') {
    existing = insertAnswer(f, answer);
    mark(f, answer.answerId, 'sending');
  }
  if (phase === 'receipt') {
    f.store.db.prepare("UPDATE chat_answer_deliveries SET error='receipt write interrupted' WHERE answer_id=?").run(answer.answerId);
  }
  const restarted = f.makeDelivery();
  const recovery = await restarted.recover();
  assert.equal(recovery.checked, 1);
  const restored = restarted.receipt(answer.answerId);
  assert.equal(restored.stored, phase !== 'accepted');
  assert.equal(restored.retryAllowed, phase === 'accepted');
  assert.equal(restored.messageId, existing?.id ?? null);
  assert.equal(f.counts.receive, 0, 'startup only reconciles; it cannot resend');
  assert.equal(f.answers.get(answer.answerId).sessionGroup, answer.sessionGroup);
});

test('startup lookup failure retains uncertainty and a later refresh can recover the row', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept(), row = insertAnswer(f, answer);
  mark(f, answer.answerId, 'sending');
  f.setQueryError(true);
  const restarted = f.makeDelivery();
  assert.equal((await restarted.recover()).pending, 1);
  assert.equal(restarted.receipt(answer.answerId).retryAllowed, false);
  f.setQueryError(false);
  const result = await restarted.reconcile(answer.answerId);
  assertCommitted(result);
  assert.equal(result.messageId, row.id);
  assert.equal(f.counts.receive, 0);
});

test('a receipt persistence failure leaves a recoverable sending record after the real insert committed', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  f.store.db.exec("CREATE TRIGGER reject_committed_receipt BEFORE UPDATE OF state ON chat_answer_deliveries WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'fixture receipt write interrupted'); END");
  await assert.rejects(f.delivery.deliver(answer.answerId, { initial: true }), /fixture receipt write interrupted/);
  assert.equal(deliveryRow(f, answer.answerId).state, 'sending');
  assert.equal(f.counts.receive, 1);
  assert.equal(f.answerRows(answer.answerId).length, 1);
  f.store.db.exec('DROP TRIGGER reject_committed_receipt');
  const restarted = f.makeDelivery();
  await restarted.recover();
  assertCommitted(restarted.receipt(answer.answerId));
  await restarted.deliver(answer.answerId, { retry: true });
  assert.equal(f.counts.receive, 1);
});

test('an interrupted startup pass still permits a later refresh to reconcile untouched sending records', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept(), existing = insertAnswer(f, answer);
  mark(f, answer.answerId, 'sending');
  const restarted = f.makeDelivery(), original = restarted.db;
  restarted.db = new Proxy(original, { get(target, key) {
    if (key === 'prepare') return sql => {
      if (sql.includes("SELECT d.answer_id FROM chat_answer_deliveries d WHERE")) {
        throw Error('fixture startup database read unavailable');
      }
      return target.prepare(sql);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(restarted.recover(), /fixture startup database read unavailable/);
  assert.equal(deliveryRow(f, answer.answerId).state, 'sending', 'startup did not reach this record');
  restarted.db = original;
  const refreshed = await restarted.reconcile(answer.answerId);
  assertCommitted(refreshed);
  assert.equal(refreshed.messageId, existing.id);
  assert.equal(f.counts.receive, 0, 'refresh only checks authority; it cannot resend');
});

for (const lookup of ['found', 'absent', 'failed']) test(`a committed receipt without an ID immediately checks authority when lookup is ${lookup}`, async t => {
  const f = answerDeliveryFixture(t); await f.delivery.recover();
  const { answer } = f.accept();
  f.setInvoke(async args => {
    if (lookup !== 'absent') await f.realReceive(args);
    if (lookup === 'failed') f.setQueryError(true);
    throw dataError('UNHEALTHY_NOTIFY_UNCERTAIN', 'committed without receipt ID', { persisted: ['D1'] });
  });
  const result = await f.delivery.deliver(answer.answerId, { initial: true });
  assertCommitted(result);
  assert.equal(f.counts.queries, 2, 'one initial lookup and one immediate post-receipt lookup');
  assert.equal(result.messageId, lookup === 'found' ? f.answerRows(answer.answerId)[0].id : null);
  assert.equal(result.needsReconciliation, lookup !== 'found');
  assert.equal(deliveryRow(f, answer.answerId).state, 'committed', 'D1 evidence survives failed or absent lookup');
  const restarted = f.makeDelivery();
  const recovered = await restarted.recover();
  assert.equal(recovered.checked, lookup === 'found' ? 0 : 1);
  await restarted.deliver(answer.answerId, { retry: true });
  assert.equal(f.counts.receive, 1);
});

test('loss of a previously committed authority row cannot turn its receipt into a retry', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  const sent = await f.delivery.deliver(answer.answerId, { initial: true });
  f.db.prepare('DELETE FROM conversations WHERE id=?').run(sent.messageId);
  const restored = await f.makeDelivery().deliver(answer.answerId, { retry: true });
  assertCommitted(restored);
  assert.equal(restored.needsReconciliation, true);
  assert.equal(f.counts.receive, 1);
});

test('reconciliation reads bounded group pages when the matching answer is late in history', async t => {
  const f = answerDeliveryFixture(t); await f.delivery.recover();
  const { answer } = f.accept();
  f.db.transaction(() => {
    const insert = f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status) VALUES('in','dashboard',?,?,?,'pending')");
    for (let i = 0; i < 205; i++) insert.run(answer.endpointId, answer.sessionGroup, `unrelated ${i}`);
  })();
  const row = insertAnswer(f, answer);
  const result = await f.delivery.deliver(answer.answerId, { initial: true });
  assertCommitted(result);
  assert.equal(result.messageId, row.id);
  assert.equal(f.counts.pages, 3);
  assert.equal(f.counts.maxPage, 100);
  assert.equal(f.counts.receive, 0);
});

test('the second exact match stops parsing later records and prevents later page reads', async t => {
  const f = answerDeliveryFixture(t); await f.delivery.recover();
  const { answer } = f.accept();
  insertAnswer(f, answer); const second = insertAnswer(f, answer);
  f.db.transaction(() => {
    const insert = f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status) VALUES('in','dashboard',?,?,?,'pending')");
    for (let i = 0; i < 205; i++) insert.run(answer.endpointId, answer.sessionGroup, `after second match ${i}`);
  })();
  let contentReads = 0;
  f.setContentProbe(row => {
    assert.ok(row.id <= second.id, 'a record after the second match must not be parsed');
    contentReads++;
  });
  const result = await f.delivery.deliver(answer.answerId, { initial: true });
  assert.equal(result.error, 'chat_answer_duplicate');
  assert.equal(result.needsReconciliation, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(contentReads, 3, 'the group seed and the two exact matches are parsed; nothing after them');
  assert.equal(f.counts.pages, 1, 'later pages were not read');
  assert.equal(f.counts.receive, 0);
});

test('a group with only settled answers performs no reconciliation scans on refresh or recovery', async t => {
  const f = answerDeliveryFixture(t); await f.delivery.recover();
  let sessionGroup;
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const { answer } = f.accept();
    const row = insertAnswer(f, answer);
    mark(f, answer.answerId, 'committed', row.id);
    ids.push(answer.answerId); sessionGroup = answer.sessionGroup;
  }
  f.db.transaction(() => {
    const insert = f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status) VALUES('in','dashboard','answer-group',?,?,'pending')");
    for (let i = 0; i < 205; i++) insert.run(sessionGroup, `settled group history ${i}`);
  })();
  f.setQueryError(true);
  const before = f.store.db.prepare('SELECT answer_id,state,c4_id,error FROM chat_answer_deliveries ORDER BY answer_id').all();
  const group = await f.delivery.reconcileGroup(sessionGroup, { limit: 1 });
  assert.equal(group.items.length, 0);
  assert.equal(group.nextCursor, null);
  assert.equal((await f.delivery.recover()).checked, 0);
  for (const id of ids) {
    const result = await f.delivery.reconcile(id);
    assertCommitted(result);
    assert.equal(result.deliveryState, 'pending');
    assert.equal(result.needsReconciliation, false);
    assert.equal(Object.hasOwn(result, 'error'), false);
  }
  const after = f.store.db.prepare('SELECT answer_id,state,c4_id,error FROM chat_answer_deliveries ORDER BY answer_id').all();
  assert.deepEqual(after, before);
  assert.equal(f.counts.queries, 0, 'settled rows use scoped status-by-ID reads, never group scans');
  assert.equal(f.counts.pages, 0);
  assert.equal(f.counts.receive, 0);
});

test('authorization is rechecked after Core loading before persisting a sending marker or entering receive', async t => {
  const f = answerDeliveryFixture(t), { answer } = f.accept();
  let loaded = false;
  f.sender.loadCore = async () => { await Promise.resolve(); loaded = true; return f.core; };
  await assert.rejects(f.delivery.deliver(answer.answerId, { initial: true, authorize() {
    assert.equal(loaded, true);
    return { status: 403, error: 'chat_requires_multi' };
  } }), { statusCode: 403, code: 'chat_requires_multi' });
  assert.equal(deliveryRow(f, answer.answerId).state, 'not_stored');
  assert.equal(f.counts.receive, 0);
  assert.equal(f.answerRows(answer.answerId).length, 0);
});
