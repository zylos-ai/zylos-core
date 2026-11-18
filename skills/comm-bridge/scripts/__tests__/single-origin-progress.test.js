import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

function setup(t, readConfig = () => ({ state: 'ok', config: { session_mode: 'single' } })) {
  const f = fixture(t, { readConfig });
  const seed = (id, group, status = 'pending', channel = 'telegram') => {
    f.db.prepare('INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,\'in\',?,\'message\',?,?)').run(id, channel, status, group);
    f.db.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET head_id=max(head_id,excluded.head_id)').run(group, id);
  };
  return { ...f, seed };
}

test('delivery records origin atomically and pending input blocks its checkpoint', t => {
  const { db, store: s, seed } = setup(t);
  seed(9, 'origin', 'delivered'); s.createCheckpoint('origin', 9, 'coverage');
  seed(10, 'telegram:a'); seed(11, 'telegram:b');
  assert.equal(s.claimConversation(11, { sessionMode: 'single' }), true);
  assert.equal(s.markDelivered(11, { sessionId: 'session', sessionGroup: 'origin' }), true);
  assert.equal(db.prepare('SELECT session_group FROM conversations WHERE id=11').get().session_group, 'origin');
  assert.deepEqual(db.prepare('SELECT * FROM group_heads ORDER BY session_group').all(), [
    { session_group: 'origin', head_id: 11 }, { session_group: 'telegram:a', head_id: 10 }, { session_group: 'telegram:b', head_id: 11 },
  ]);
  assert.equal(s.getDeliveredFrontier('origin'), 9);
  assert.throws(() => s.createCheckpoint('origin', 11, 'gap'), { code: 'CHECKPOINT_GAP' });
  assert.equal(s.markDelivered(10, { sessionGroup: 'origin' }), false);
  assert.equal(db.prepare('SELECT session_group FROM conversations WHERE id=10').get().session_group, 'telegram:a');
  s.claimConversation(10, { sessionMode: 'single' }); s.markDelivered(10, { sessionGroup: 'origin' });
  assert.equal(s.getDeliveredFrontier('origin'), 11);
  assert.equal(s.createCheckpoint('origin', 11, 'complete').end_conversation_id, 11);
  assert.equal(db.prepare("SELECT head_id FROM group_heads WHERE session_group='origin'").get().head_id, 11);
});

for (const [name, result, conservative] of [
  ['single', { state: 'ok', config: { session_mode: 'single' } }, true],
  ['unreadable', { state: 'unreadable' }, true],
  ['invalid mode', { state: 'ok', config: { session_mode: 'broken' } }, true],
  ['missing file', { state: 'missing' }, false],
  ['missing key', { state: 'ok', config: {} }, false],
  ['multi', { state: 'ok', config: { session_mode: 'multi' } }, false],
]) test(`origin frontier uses ${name} configuration and never borrows another group's head`, t => {
  const { db, store: s, seed } = setup(t, () => result);
  seed(9, 'origin', 'delivered'); s.createCheckpoint('origin', 9, 'coverage');
  seed(11, 'origin', 'delivered'); seed(20, 'telegram:a');
  assert.equal(s.getDeliveredFrontier('origin'), 11);
  s.createCheckpoint('origin', 11, 'head');
  seed(21, 'telegram:a'); seed(23, 'origin', 'delivered');
  db.prepare("INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES('telegram:a','delete','deleting',1)").run();
  assert.equal(s.getDeliveredFrontier('origin'), conservative ? 19 : 23);
  assert.equal(s.getUnsummarizedRange('origin').safeEnd, conservative ? 19 : 23);
  if (conservative) {
    assert.throws(() => s.createCheckpoint('origin', 23, 'gap'), { code: 'CHECKPOINT_GAP' });
    assert.throws(() => s.getUnsummarizedConversations('origin', { upToConversationId: 23 }), { code: 'UPTO_BEYOND_FRONTIER' });
  } else s.createCheckpoint('origin', 23, 'multi');
});

test('an open transition and a thrown config read both retain all-group gaps', t => {
  let throwing = false;
  const { db, store: s, seed } = setup(t, () => { if (throwing) throw new Error('read failure'); return { state: 'missing' }; });
  seed(10, 'telegram:a'); seed(11, 'origin', 'delivered');
  assert.equal(s.getDeliveredFrontier('origin'), 11);
  s.beginModeTransition('multi', 'single');
  assert.equal(s.getDeliveredFrontier('origin'), 9);
  assert.throws(() => s.createCheckpoint('origin', 11, 'gap'), { code: 'CHECKPOINT_GAP' });
  db.exec('DELETE FROM mode_transitions'); throwing = true;
  assert.equal(s.getDeliveredFrontier('origin'), 9);
});

test('origin fences block single selection and late claims without reading configuration', t => {
  const { store: s, seed } = setup(t, () => { throw new Error('selection must not read config'); });
  seed(10, 'telegram:a'); seed(11, 'telegram:b');
  s.setDrainFence('origin', { reason: 'ttl', runId: 'run' });
  assert.equal(s.getNextPending({ sessionMode: 'single' }), null);
  assert.equal(s.claimConversation(10, { sessionMode: 'single' }), false);
  assert.equal(s.getNextPending({ sessionMode: 'multi' }).id, 10);
  assert.equal(s.getNextPending().id, 10);
  assert.equal(s.claimConversation(11), true);
  s.clearDrainFence('origin');
  assert.equal(s.claimConversation(10, { sessionMode: 'single' }), true);
});

test('scheduled input changes its recording group only on successful delivery', t => {
  const { db, store: s, seed } = setup(t);
  seed(10, 'telegram:a', 'pending', 'scheduler');
  s.claimConversation(10, { sessionMode: 'single' });
  s.failDelivery(10);
  assert.equal(db.prepare('SELECT session_group FROM conversations WHERE id=10').get().session_group, 'telegram:a');
  s.claimConversation(10, { sessionMode: 'single' }); s.markDelivered(10, { sessionGroup: 'origin' });
  assert.equal(db.prepare('SELECT session_group FROM conversations WHERE id=10').get().session_group, 'origin');
});
