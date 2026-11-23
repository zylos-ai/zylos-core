import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { ChatAnswers } from '../src/lib/chat/answers.js';
import { dashboardSchemaOwner as owner } from '../src/lib/schema-owner.js';
import { TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const example = name => structuredClone(fixtures.valid.find(item => item.name === name).envelope);

const canonical = group => `g:${Buffer.from(group).toString('hex').toUpperCase()}`;

// Real Dashboard Store + U validation, private fixture database only. Run for
// answer acceptance, conditional transaction, lifecycle or migration changes;
// unrelated UI changes may skip. No C4, child, listener, PM2, tmux or network.
// Every connection closes before this case's own directory is removed.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-answer-store-'));
  const file = path.join(root, 'dashboard.db');
  const store = new Store(file), answers = new ChatAnswers({ store, now: () => 1000 });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let nextId = 1;
  function question(name = 'single', { group = 'dashboard:mine', endpoint = 'mine', interruptId } = {}) {
    const envelope = example(name);
    if (interruptId) envelope.interruptId = interruptId;
    const id = String(nextId++), block = envelope.blocks.find(item => item.id === envelope.interrupt.blockId);
    store.db.prepare(`INSERT INTO chat_questions
      (c4_id,session_group,endpoint_id,message_id,interrupt_id,question_summary,constraints)
      VALUES(?,?,?,?,?,?,?)`).run(id, group, endpoint, envelope.messageId, envelope.interruptId,
      envelope.questionSummary, JSON.stringify({ block, interrupt: envelope.interrupt }));
    return { envelope, id, group, endpoint };
  }
  function action(q, payload, id = 'answer_action_01') {
    const block = q.envelope.blocks.find(item => item.id === q.envelope.interrupt.blockId);
    return { id, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
      context: { messageId: q.envelope.messageId, blockId: block.id, conversationId: canonical(q.group) }, payload };
  }
  const accept = (q, request) => answers.accept({ sessionGroup: q.group, endpointId: q.endpoint,
    interruptId: q.envelope.interruptId, action: request });
  const count = table => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  return { store, answers, file, question, action, accept, count };
}

// Boundary: savedEnvelope reconstructs old records permissively, but the real
// answer transaction must apply current checks before writing. Run for shared
// validation/answer changes; unrelated UI changes may skip. Private SQLite only;
// the official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, no sockets spawned.

for (const [name, payload, readable] of [
  ['single', { selected: ['a'] }, '方案甲'],
  ['multiple', { selected: ['a', 'b'] }, '第一项、第二项'],
  ['confirmation', { outcome: 'cancel' }, '取消'],
  ['form', { values: { name: 'Saved value', count: 1, tags: ['a'] } }, '名字：Saved value；数量：1；标签：甲'],
]) {
  test(`accepting a ${name} answer saves the host summary and unfinished delivery atomically`, t => {
    const f = fixture(t), q = f.question(name);
    const action = f.action(q, payload), accepted = f.accept(q, action);
    assert.equal(accepted.created, true);
    assert.equal(f.answers.question(q.group, q.envelope.interruptId).status, 'answered');
    const content = parseC4Content(accepted.answer.content);
    assert.equal(content.kind, 'envelope');
    assert.equal(content.envelope.questionSummary, q.envelope.questionSummary);
    assert.equal(content.envelope.metadata.zylos.answerId, action.id);
    assert.equal(content.envelope.fallbackText,
      `Re interruptId=${q.envelope.interruptId} (Q:${q.envelope.questionSummary}): ${readable}`);
    const delivery = f.store.db.prepare('SELECT * FROM chat_answer_deliveries WHERE answer_id=?').get(action.id);
    assert.equal(delivery.state, 'pending'); assert.equal(delivery.c4_id, null);
    assert.equal(accepted.answer.sessionGroup, q.group); assert.equal(accepted.answer.endpointId, q.endpoint);
    assert.equal(f.count('chat_answers'), 1); assert.equal(f.count('chat_answer_deliveries'), 1);
  });
}

test('same action reuses the saved answer while different answers and altered intent cannot overwrite it', async t => {
  const f = fixture(t), q = f.question(), block = q.envelope.blocks[0];
  const first = f.action(q, { selected: [block.data.options[0].id] });
  const second = f.action(q, { selected: [block.data.options[1].id] }, 'answer_action_02');
  const results = await Promise.allSettled([Promise.resolve().then(() => f.accept(q, first)), Promise.resolve().then(() => f.accept(q, second))]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const duplicate = f.accept(q, first);
  assert.equal(duplicate.created, false); assert.equal(duplicate.answer.answerId, first.id);
  assert.throws(() => f.accept(q, { ...second, id: first.id }), { code: 'chat_answer_conflict' });
  const reordered = { payload: first.payload, context: first.context, target: first.target,
    type: first.type, protocolVersion: first.protocolVersion, id: first.id };
  assert.equal(f.accept(q, reordered).created, false);
  assert.equal(f.count('chat_answers'), 1); assert.equal(f.count('chat_answer_deliveries'), 1);
});

test('unknown and cross-group questions cannot be answered through another original group', t => {
  const f = fixture(t), q = f.question(), action = f.action(q, { selected: [q.envelope.blocks[0].data.options[0].id] });
  assert.throws(() => f.answers.accept({ sessionGroup: 'dashboard:other', endpointId: 'other', interruptId: q.envelope.interruptId, action }), { code: 'chat_question_not_found' });
  assert.throws(() => f.answers.accept({ sessionGroup: q.group, endpointId: q.endpoint, interruptId: 'missing_question', action }), { code: 'chat_question_not_found' });
  assert.equal(f.count('chat_answers'), 0);
});

// Migration fixture removes only this additive schema's tables and version,
// recreating the previous layout without changing runtime source. Run whenever
// the answer storage layout changes; unrelated UI work may skip.
test('answer schema upgrades the prior draft layout without changing questions, drafts, names or user tables', t => {
  const f = fixture(t), q = f.question();
  f.store.db.exec(`INSERT INTO chat_conversations(local_id,display_name,created_at,updated_at) VALUES('retained','Draft',1,1);
    INSERT INTO group_display_names(session_group,display_name,source) VALUES('dashboard:mine','Human title','human');
    CREATE TABLE user_answer_notes(note TEXT); INSERT INTO user_answer_notes VALUES('retained');
    DROP TABLE chat_answer_deliveries; DROP TABLE chat_answers; DROP TABLE chat_question_controls;
    DELETE FROM schema_migrations WHERE version>=25;`);
  const before = f.store.db.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(q.id);
  assert.equal(owner.inspectSchema(f.store.db).currentVersion, 24);
  assert.equal(owner.migrate(f.store.db).currentVersion, TARGET_SCHEMA_VERSION);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(q.id), before);
  assert.equal(f.store.db.prepare('SELECT display_name FROM chat_conversations').get().display_name, 'Draft');
  assert.equal(f.store.db.prepare('SELECT display_name FROM group_display_names').get().display_name, 'Human title');
  assert.equal(f.store.db.prepare('SELECT note FROM user_answer_notes').get().note, 'retained');
  owner.migrate(f.store.db);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=25').get().n, 1);
});

// Index admission uses real private SQLite layouts on a readonly caller handle.
// Run for answer schema/index inspection changes; UI-only changes may skip.
// Failed inspection and migration must leave the fixture's database bytes intact.
