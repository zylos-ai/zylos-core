import test from 'node:test';
import assert from 'node:assert/strict';
import { answerDeliveryFixture } from './helpers/answer-delivery-fixture.js';

import { parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
import { formatConversation } from '../../comm-bridge/scripts/router/format.js';

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
  const row = f.answerRows(answer.answerId)[0];
  const envelope = parseC4Content(row.content).envelope;
  assert.equal(envelope.questionSummary, '选一个方案');
  const expected = `Re interruptId=${envelope.interruptId} (Q:选一个方案): 方案甲`;
  assert.equal(envelope.fallbackText, expected);
  assert.ok(formatConversation(row, { ownerName: () => 'Owner' }).includes(`\nOwner said: ${expected}\n`));
  assert.equal(envelope.metadata.zylos.answerId, answer.answerId);
  assert.equal(f.counts.receive, 1);
  await f.delivery.deliver(answer.answerId);
  await f.delivery.deliver(answer.answerId, { retry: true });
  assert.equal(f.counts.receive, 1, 'ordinary duplicate and explicit retry both reuse a committed answer');
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
