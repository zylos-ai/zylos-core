// Interface: real HTTP middleware + two Dashboard/C4 database pairs; run for
// access/history/channel/draft/answer changes, skip CSS-only changes.
// Faults: actual receive inserts under unavailable/suppressed/failed notification
// adapters, receipt loss and independent HTTP-process restart; run for recovery.
// Remote access: real AuthGate + FleetProxy and data-instance settings; run for
// auth/fleet/chat routes; unrelated block styles may skip.
// Single: actual converter/coordinator with isolated restart acknowledgement,
// then all three write APIs; run for mode/access/draft/answer changes.
// Every case requires ZYLOS_CHAT_INTEGRATION=1 before DB/HTTP creation; absence
// skips all work. No live history, PM2, tmux socket or model is used here.
import strictAssert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture, createRemoteChatApiFixture, questionContent, assertChatProcessIsolation } from './helpers/chat-integration-api.js';
import { acceptDelivery } from '../src/lib/chat/channel.js';
import { makeQuestionSummary, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
import { ATTACHMENT_SEND_WINDOW_MS, ATTACHMENT_TTL_MS, ATTACHMENT_GC_INTERVAL_MS } from '../src/lib/chat/attachments.js';
import { buildAnnotatedContent } from '../../web-console/scripts/attachment-utils.js';
import { fixturePng } from './helpers/chat-attachments-api.js';

const conditionalFixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
const expectedFieldErrors = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/form-field-errors.json', import.meta.url), 'utf8'));

let assertionCount = 0;
const assert = new Proxy(strictAssert, { get(target, key) {
  const value = Reflect.get(target, key);
  return typeof value === 'function' ? (...args) => { assertionCount++; return value(...args); } : value;
} });

const enabled = chatEnabled();
const options = { skip: !enabled, timeout: 45000 };
const post = body => ({ method: 'POST', body });

const attachmentCase = (name, operation) => registerIntegrationCase(`attachment integration: ${name}`, operation);
const attachmentDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const attachmentRoute = id => `/api/chat/conversations/${encodeURIComponent(id)}`;
async function uploadAttachment(api, route, bytes = Buffer.from('private attachment bytes'), { name = 'report.txt', mime = 'text/plain', ...options } = {}) {
  const body = new FormData(); body.append('file', new Blob([bytes], { type: mime }), name);
  const response = await api.rawRequest(route + '/uploads', { method: 'POST', body, ...options });
  return { status: response.status, body: await response.json() };
}
async function attachmentDraft(api) {
  const result = await api.request('/api/chat/drafts', post({}));
  assert.equal(result.status, 201);
  return { draft: result.body.conversation, route: attachmentRoute(result.body.conversation.id) };
}
async function sendAttachments(api, route, ids, content = '', options = {}) {
  return api.request(route + '/send', { ...post({ content, attachments: ids }), ...options });
}
function savedAttachment(api, id) { return api.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(id); }
function expireAttachment(api, id, age = ATTACHMENT_TTL_MS) {
  const now = Date.now();
  api.store.db.prepare('UPDATE chat_attachments SET created_at=?,next_check_at=? WHERE id=?').run(now - age, now - 1, id);
}
async function assertAttachmentBytes(api, route, id, bytes, options = {}) {
  const result = await api.rawRequest(`${route}/attachments/${id}`, options);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-length'), String(bytes.length));
  assert.equal(attachmentDigest(Buffer.from(await result.arrayBuffer())), attachmentDigest(bytes));
}

// Every registered case uses a runner-owned sandbox: private HOME, ZYLOS_DIR,
// PM2_HOME, short TMPDIR, explicit tmux socket and both test DB paths are read
// back before HTTP/children start. The captured process Core paths are proved
// separately because modules imported before a case belong to the runner.

export function registerIntegrationCase(name, operation) {
  test(name, options, async t => {
    const sandbox = createChatSandbox(t);
    assertionCount = 0;
    try { await sandbox.runCase(() => operation(t, sandbox)); }
    finally { console.log(`Chat case direct assertion calls: ${assertionCount}; ${name}`); }
  });
}

// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are read back; case teardown reclaims them.
registerIntegrationCase('HTTP conversation, channel question and conditional answer stay in their original instance and group', async (t, sandbox) => {
  const otherSandbox = createChatSandbox(t);
  try {
    const a = await createChatApiFixture(t, sandbox, { name: 'a' });
    const b = await createRemoteChatApiFixture(t, otherSandbox);
    const first = await a.createConversation('first text a');
    const second = await b.createConversation('first text b');
    assert.equal(a.db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 1);
    assert.equal((await b.snapshot()).conversations, 1);
    assert.equal(first.receipt.stored, true);
    assert.equal(first.receipt.deliveryState, 'pending');
    const question = a.question();
    const outbound = a.addOutbound(first.draft.localId, questionContent(question));
    a.addOutbound(first.draft.localId, 'supplement does not answer the question');
    const page = await a.request(first.route + '/questions');
    assert.equal(page.status, 200); assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].status, 'paused');
    const body = a.answer(question, 'http-original-action');
    for (const request of [
      () => a.request(first.route + '/answers', { ...post(body), identity: 'read' }),
      () => a.request(first.route + '/answers', post({ ...body, sessionGroup: second.receipt.conversationId })),
      () => b.request(first.route + '/answers', post(body)),
      () => a.request(`/api/chat/conversations/g:74673A65787465726E616C/send`, post({ content: 'forged' })),
    ]) assert.ok((await request()).status >= 400);
    assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answers').get().n, 0);
    const answered = await a.request(first.route + '/answers', post(body));
    assert.equal(answered.status, 200); assert.equal(answered.body.delivery.stored, true);
    assert.equal(answered.body.delivery.deliveryState, 'pending');
    const repeated = await a.request(first.route + '/answers', post(body));
    assert.equal(repeated.status, 200);
    assert.equal(a.answerRows(body.action.id).length, 1);
    const saved = a.answerRows(body.action.id)[0];
    assert.equal(saved.endpoint_id, first.draft.localId); assert.equal(saved.session_group, outbound.session_group);
    assert.ok(saved.content.includes(question.questionSummary));
    assert.equal((await b.answerRows(body.action.id)).length, 0);
    assert.equal((await b.snapshot()).conversations, 1);
    assert.equal(a.answers.question(outbound.session_group, question.interruptId).status, 'answered');
    const bodyRead = await a.request(first.route + '/messages?tab=mine');
    assert.equal(bodyRead.status, 200); assert.equal(bodyRead.body.items.length, 4);
    assert.ok(bodyRead.body.items.some(row => row.content === questionContent(question)));
    assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answers').get().n, 1);
    assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answer_deliveries').get().n, 1);
  } finally { await otherSandbox.close(); }
});

// Boundary: authoritative C4 channel registration -> HTTP/AuthGate -> saved
// conditional validation -> Dashboard transaction -> real in-process receive.
// Run for conditional answers or saved-question changes; unrelated UI may skip.
// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are
// read back before resources start, and reclaimed on completion/failure/timeout.
for (const example of conditionalFixtures.answers) {
  registerIntegrationCase(`HTTP conditional answer validates ${example.name}`, async (t, sandbox) => {
    const a = await createChatApiFixture(t, sandbox);
    const active = await a.createConversation();
    const question = structuredClone(conditionalFixtures.formQuestion);
    question.questionSummary = makeQuestionSummary(question);
    const outbound = a.addOutbound(active.draft.localId, questionContent(question));
    const body = a.answer(question, `http_${example.name}`);
    body.action.payload = { values: structuredClone(example.values) };
    const before = a.counts.receive;
    const result = await a.request(active.route + '/answers', post(body));
    if (!example.valid) {
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: 'invalid_chat_answer',
        fields: expectedFieldErrors[example.name] });
      assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answers').get().n, 0);
      assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answer_deliveries').get().n, 0);
      assert.equal(a.answerRows(body.action.id).length, 0);
      assert.equal(a.counts.receive, before);
      assert.equal(a.answers.question(outbound.session_group, question.interruptId).status, 'paused');
      return;
    }
    assert.equal(result.status, 200);
    assert.equal(result.body.delivery.stored, true);
    assert.equal(a.counts.receive, before + 1);
    const rows = a.answerRows(body.action.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint_id, active.draft.localId);
    assert.equal(rows[0].session_group, outbound.session_group);
    const parsed = parseC4Content(rows[0].content);
    assert.equal(parsed.kind, 'envelope');
    assert.equal(parsed.envelope.version, 1);
    assert.equal(parsed.envelope.action.protocolVersion, '0.1');
    assert.deepEqual(parsed.envelope.action.context, body.action.context);
    assert.deepEqual(parsed.envelope.action.payload.values, example.values);
    assert.equal(parsed.envelope.questionSummary, question.questionSummary);
    assert.equal(parsed.envelope.metadata.zylos.answerId, body.action.id);
    assert.equal((await a.request(active.route + '/answers', post(body))).status, 200);
    assert.equal(a.counts.receive, before + 1);
    assert.equal(a.answerRows(body.action.id).length, 1);
    assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answers').get().n, 1);
    assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answer_deliveries').get().n, 1);
  });
}

// Boundary: historical View degradation must not block channel registration or
// HTTP answers. Run for parser/registration/saved-constraint changes; UI may skip.
// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are
// read back before resources start, and reclaimed on completion/failure/timeout.
for (const [name, view, legal] of [
  ['legal', { schemaVersion: 1, root: 'layout', nodes: [{ id: 'layout', type: 'block', blockId: 'customer_form' }] }, true],
  ['scalar', 1, false],
  ['unknown', { schemaVersion: 99, root: 'layout', nodes: [] }, false],
  ['overdeep', { schemaVersion: 1, root: 'layout', nodes: [{ id: 'layout', type: 'block', blockId: 'customer_form', extra: { b: { c: 1 } } }] }, false],
]) {
  registerIntegrationCase(`HTTP conditional answer survives ${name} historical View`, async (t, sandbox) => {
    const a = await createChatApiFixture(t, sandbox);
    const active = await a.createConversation();
    const question = structuredClone(conditionalFixtures.formQuestion);
    question.questionSummary = makeQuestionSummary(question);
    question.metadata = { view };
    const content = questionContent(question), parsed = parseC4Content(content);
    assert.equal(parsed.kind, 'envelope');
    assert.equal('viewError' in parsed, !legal);
    // Bad Views cannot be produced today. Insert an actual historical C4 row,
    // then use the real channel's authoritative readback and registration.
    const row = a.c4.insertConversation('out', 'dashboard', active.draft.localId, content, { groupName: active.draft.localId });
    acceptDelivery({ version: 1, c4_id: row.id, channel: row.channel, endpoint_id: row.endpoint_id,
      session_group: row.session_group, content }, { env: sandbox.env });
    const saved = a.answers.question(row.session_group, question.interruptId);
    assert.deepEqual(JSON.parse(saved.constraints), { block: question.blocks[0], interrupt: question.interrupt });
    const page = await a.request(active.route + '/questions');
    assert.equal(page.status, 200); assert.equal(page.body.items.length, 1);
    const body = a.answer(question, `http_view_${name}`);
    body.action.payload = { values: { customer_type: 'person' } };
    const before = a.counts.receive;
    const result = await a.request(active.route + '/answers', post(body));
    assert.equal(result.status, 200); assert.equal(result.body.delivery.stored, true);
    assert.equal(a.counts.receive, before + 1);
    assert.equal(a.answerRows(body.action.id).length, 1);
    assert.equal(a.db.prepare('SELECT content FROM conversations WHERE id=?').get(row.id).content, content);
  });
}

// Boundary: only paused v2 field refusals expose diagnostics. Run for answer
// diagnostics or routing changes; unrelated UI may skip. Private HOME/ZYLOS_DIR/
// PM2_HOME/short TMPDIR/socket/DBs are read back before opens and reclaimed.
registerIntegrationCase('HTTP conditional answer keeps action authorization and lifecycle errors separate from field reasons', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const question = structuredClone(conditionalFixtures.formQuestion);
  question.questionSummary = makeQuestionSummary(question);
  const row = a.addOutbound(active.draft.localId, questionContent(question));
  const valid = a.answer(question, 'http_field_errors');
  valid.action.payload = { values: { customer_type: 'person' } };
  const invalid = structuredClone(valid);
  invalid.action.payload.values.company_name = null;
  const before = a.counts.receive;
  for (const change of [
    action => { action.protocolVersion = '0.2'; },
    action => { action.context.messageId = 'another_message'; },
    action => { action.context.blockId = 'another_block'; },
    action => { action.context.conversationId = 'g:666F726569676E'; },
    action => { action.target = 'another.handler'; },
    action => { action.schemaVersion = 2; },
  ]) {
    const body = structuredClone(invalid); change(body.action);
    const result = await a.request(active.route + '/answers', post(body));
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'invalid_chat_answer' });
  }
  const denied = await a.request(active.route + '/answers', { ...post(invalid), identity: 'read' });
  assert.equal(denied.status, 403); assert.equal(Object.hasOwn(denied.body, 'fields'), false);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answers').get().n, 0);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answer_deliveries').get().n, 0);
  assert.equal(a.counts.receive, before);
  const result = await a.request(active.route + '/answers', post(valid));
  assert.equal(result.status, 200); assert.equal(result.body.delivery.stored, true);
  const conflicted = structuredClone(valid); conflicted.action.payload.values.customer_type = 'partner';
  const conflict = await a.request(active.route + '/answers', post(conflicted));
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.body, { error: 'chat_answer_conflict' });
  const nonpaused = structuredClone(valid); nonpaused.action.id = 'http_other_answer';
  const closed = await a.request(active.route + '/answers', post(nonpaused));
  assert.equal(closed.status, 409); assert.deepEqual(closed.body, { error: 'chat_question_not_paused' });
  const badClosed = await a.request(active.route + '/answers', post(invalid));
  assert.equal(badClosed.status, 400); assert.deepEqual(badClosed.body, { error: 'invalid_chat_answer' });
  assert.equal(a.counts.receive, before + 1); assert.equal(a.answerRows(valid.action.id).length, 1);
  assert.equal(a.answers.question(row.session_group, question.interruptId).status, 'answered');
});

// Boundary: v1 keeps its generic rejection and freeText retains its permission.
// Run for shared field diagnostics or answer error changes; UI-only may skip.
// Private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DBs precede opens; teardown.
registerIntegrationCase('HTTP conditional answer preserves legacy field errors and free-text permission', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const question = structuredClone(conditionalFixtures.formQuestion);
  question.blocks[0].schemaVersion = 1;
  for (const field of question.blocks[0].data.fields) delete field.activeWhen;
  question.questionSummary = makeQuestionSummary(question);
  a.addOutbound(active.draft.localId, questionContent(question));
  const body = a.answer(question, 'http_legacy_fields');
  body.action.payload = { values: { customer_type: 'person' } };
  const before = a.counts.receive;
  const rejected = await a.request(active.route + '/answers', post(body));
  assert.equal(rejected.status, 400); assert.deepEqual(rejected.body, { error: 'invalid_chat_answer' });
  const conditional = structuredClone(conditionalFixtures.formQuestion);
  conditional.messageId += '_free'; conditional.interruptId += '_free';
  conditional.interrupt.otherInput = false;
  conditional.questionSummary = makeQuestionSummary(conditional);
  a.addOutbound(active.draft.localId, questionContent(conditional));
  const free = a.answer(conditional, 'http_free_denied'); free.action.payload = { freeText: 'Please clarify' };
  const denied = await a.request(active.route + '/answers', post(free));
  assert.equal(denied.status, 400); assert.deepEqual(denied.body, { error: 'invalid_chat_answer' });
  assert.equal(a.counts.receive, before);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answers').get().n, 0);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answer_deliveries').get().n, 0);
  const allowed = structuredClone(conditional);
  allowed.messageId += '_allowed'; allowed.interruptId += '_allowed'; allowed.interrupt.otherInput = true;
  a.addOutbound(active.draft.localId, questionContent(allowed));
  const accepted = a.answer(allowed, 'http_free_allowed'); accepted.action.payload = { freeText: 'Please clarify' };
  const result = await a.request(active.route + '/answers', post(accepted));
  assert.equal(result.status, 200); assert.equal(result.body.delivery.stored, true);
  assert.equal(a.counts.receive, before + 1);
});

// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are read back; case teardown reclaims them.
registerIntegrationCase('receive failures and lost receipts preserve commit evidence across delivery restart without automatic sends', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox);
  a.setRoute({ decision: 'unavailable', runtime: 'claude', health: 'unavailable', reason: 'runtime_unavailable' });
  const first = await a.createConversation('runtime unavailable');
  assert.equal(first.receipt.action, 'delivered');
  assert.equal(first.receipt.stored, true); assert.equal(first.receipt.deliveryState, 'failed');
  a.setNotification('suppressed');
  const suppressed = await a.request(first.route + '/send', post({ content: 'cooldown text' }));
  assert.equal(suppressed.status, 200); assert.equal(suppressed.body.deliveryState, 'suppressed');
  const beforeSuppressedRetry = a.counts.receive;
  await a.request(first.route + '/send', post({ content: 'cooldown text', retry: true }));
  assert.equal(a.counts.receive, beforeSuppressedRetry);
  for (const notification of ['failed', 'uncertain']) {
    a.setNotification(notification);
    const q = a.question('single', notification); a.addOutbound(first.draft.localId, questionContent(q));
    const body = a.answer(q, `answer-${notification}`);
    const result = await a.request(first.route + '/answers', post(body));
    assert.equal(result.status, 200); assert.equal(result.body.delivery.stored, true);
    assert.equal(result.body.delivery.deliveryState, 'failed');
    const before = a.counts.receive;
    await a.restartDelivery();
    await a.request(first.route + '/answers', post({ ...body, retry: true }));
    assert.equal(a.counts.receive, before); assert.equal(a.answerRows(body.action.id).length, 1);
  }
  a.setRoute({ decision: 'pending', runtime: 'claude' }); a.setNotification('sent');
  const q = a.question('single', 'lost-receipt'); a.addOutbound(first.draft.localId, questionContent(q));
  const body = a.answer(q, 'lost-receipt-answer');
  a.setInvoke(async args => { await a.realReceive(args); throw Error('controlled lost receive receipt'); });
  const lost = await a.request(first.route + '/answers', post(body));
  assert.equal(lost.status, 200); assert.equal(lost.body.delivery.stored, true);
  assert.equal(a.answerRows(body.action.id).length, 1);
  const committedCount = a.counts.receive;
  await a.restartDelivery(); await a.request(first.route + '/questions');
  assert.equal(a.counts.receive, committedCount);
  a.setInvoke(null);
  const unknownQ = a.question('single', 'unknown'); a.addOutbound(first.draft.localId, questionContent(unknownQ));
  const unknownBody = a.answer(unknownQ, 'unknown-answer');
  a.setInvoke(async () => { a.setLookupUnavailable(true); throw Error('controlled missing receipt and unreadable C4'); });
  const unknown = await a.request(first.route + '/answers', post(unknownBody));
  assert.equal(unknown.status, 200); assert.equal(unknown.body.delivery.stored, null);
  assert.equal(unknown.body.delivery.deliveryState, 'pending_reconciliation');
  const calls = a.counts.receive;
  // This observes restart/next-turn behavior only; it is not evidence that a
  // seconds-long lease elapsed. The child-process checks below independently
  // prove unknown persistence and no startup resend across real restarts.
  await a.restartDelivery(); await delay(30);
  assert.equal(a.counts.receive, calls);
  a.setLookupUnavailable(false); a.setInvoke(null);
  await a.restartDelivery();
  const reopened = await a.request(first.route + '/questions');
  const pending = reopened.body.items.find(item => item.interruptId === unknownQ.interruptId);
  assert.equal(pending.delivery.stored, false); assert.equal(pending.delivery.retryAllowed, true);
  assert.equal(a.counts.receive, calls);
  const retried = await a.request(first.route + '/answers', post({ ...unknownBody, retry: true }));
  assert.equal(retried.status, 200); assert.equal(retried.body.delivery.stored, true);
  assert.equal(a.answerRows(unknownBody.action.id).length, 1);
  const restartSandbox = createChatSandbox(t);
  try {
    const processFixture = await createRemoteChatApiFixture(t, restartSandbox);
    const active = await processFixture.createConversation('process restart original group');
    const question = processFixture.question();
    await processFixture.addOutbound(active.draft.localId, questionContent(question));
    const answer = processFixture.answer(question, 'process-restart-answer');
    await processFixture.setInvoke('unknownC4Outage');
    const unknown = await processFixture.request(active.route + '/answers', post(answer));
    assert.equal(unknown.status, 200); assert.equal(unknown.body.delivery.stored, null);
    assert.equal((await processFixture.snapshot()).receive, 2);
    const firstRestart = await processFixture.restart({ lookupUnavailable: true });
    assert.notEqual(firstRestart.previousPid, firstRestart.pid);
    const persisted = await processFixture.snapshot();
    assert.equal(persisted.receive, 0);
    assert.equal(persisted.deliveries.length, 1); assert.equal(persisted.deliveries[0].state, 'unknown');
    const secondRestart = await processFixture.restart();
    assert.notEqual(secondRestart.previousPid, secondRestart.pid);
    const reopened = await processFixture.request(active.route + '/questions');
    assert.equal(reopened.status, 200); assert.equal(reopened.body.items.length, 1);
    assert.equal(reopened.body.items[0].answerId, answer.action.id);
    assert.equal(reopened.body.items[0].delivery.stored, false); assert.equal(reopened.body.items[0].delivery.retryAllowed, true);
    assert.equal((await processFixture.snapshot()).receive, 0);
    const retry = await processFixture.request(active.route + '/answers', post({ ...answer, retry: true }));
    assert.equal(retry.status, 200); assert.equal(retry.body.delivery.stored, true);
    assert.equal((await processFixture.answerRows(answer.action.id)).length, 1);
    assert.equal((await processFixture.snapshot()).receive, 1);
  } finally { await restartSandbox.close(); }
});

// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are read back; case teardown reclaims them.
registerIntegrationCase('remote chat off, on and off enforces both direct and proxy authorization before private reads or writes', async (t, sandbox) => {
  const remoteSandbox = createChatSandbox(t);
  try {
    const local = await createChatApiFixture(t, sandbox, { name: 'hub' });
    const remote = await createRemoteChatApiFixture(t, remoteSandbox);
    local.setProxy(remote);
    const active = await remote.createConversation('PRIVATE_REMOTE_TEXT');
    const fakeCredential = 'sk-' + 'fixturesecret'.repeat(3);
    await remote.request(active.route + '/send', post({ content: `safe ${fakeCredential} ${'public '.repeat(30)}` }));
    const q = remote.question(); await remote.addOutbound(active.draft.localId, questionContent(q));
    const reads = ['/api/chat/conversations?tab=mine', active.route, active.route + '/messages?tab=mine', active.route + '/status?tab=mine&ids=1', active.route + '/questions'];
    const writes = [ ['/api/chat/drafts', {}], [active.route + '/send', { content: 'remote new text' }], [active.route + '/answers', remote.answer(q, 'remote-answer')] ];
    for (const allowRemote of [false, true, false]) {
      const set = await remote.request('/api/chat/settings', { method: 'PUT', body: { allowRemote } });
      assert.equal(set.status, 200); assert.equal(remote.config.chat.allowRemote, allowRemote);
      if (allowRemote) for (const fleet of [false, true]) {
        const client = fleet ? local : remote;
        const options = { identity: 'admin', ...(fleet ? { fleet: true } : {}) };
        const draft = await client.request('/api/chat/drafts', { ...options, ...post({ displayName: 'remote authorized' }) });
        assert.equal(draft.status, 201);
        const first = await client.request(`/api/chat/conversations/${encodeURIComponent(draft.body.conversation.id)}/send`, {
          ...options, ...post({ content: `authorized remote ${fleet ? 'proxy' : 'direct'}` }) });
        assert.equal(first.status, 200); assert.equal(first.body.stored, true);
        const question = remote.question();
        await remote.addOutbound(draft.body.conversation.localId, questionContent(question));
        const answered = await client.request(`/api/chat/conversations/${encodeURIComponent(first.body.conversationId)}/answers`, {
          ...options, ...post(remote.answer(question, `authorized-${fleet ? 'proxy' : 'direct'}`)) });
        assert.equal(answered.status, 200); assert.equal(answered.body.delivery.stored, true);
      }
      for (const identity of ['read', 'admin']) for (const fleet of [false, true]) {
        const client = fleet ? local : remote;
        const options = { identity, ...(fleet ? { fleet: true } : {}) };
        const overview = await client.request('/api/workbench/groups', options);
        assert.equal(overview.status, 200);
        const row = overview.body.rows.find(item => item.sessionGroup?.endsWith(':' + active.draft.localId));
        assert.ok(row); assert.ok(row.state); assert.equal(row.queue.pending.count, 2);
        assert.ok(row.preview.text.length <= 80); assert.ok(row.preview.text.includes('[REDACTED]'));
        assert.ok(!overview.text.includes(fakeCredential));
        const summary = await client.request('/api/workbench/groups?view=summary', options);
        assert.equal(summary.status, 200); assert.ok(summary.body.counts);
        const search = await client.request('/api/workbench/groups/search?q=' + active.draft.localId, options);
        assert.equal(search.status, 200); assert.equal(search.body.rows.length, 1);
        assert.ok(!search.text.includes(fakeCredential));
        const activity = await client.request('/api/workbench/activity?range=60m', options);
        assert.equal(activity.status, 200); assert.ok(activity.body.groups[row.sessionGroup]);
        assert.equal(activity.body.groups[row.sessionGroup].inbound.length, 2);
      }
      for (const identity of ['read', 'admin', 'cookie']) {
        for (const route of reads) {
          const direct = await remote.request(route, { identity });
          const allowed = identity === 'cookie' || identity === 'admin' && allowRemote;
          assert.equal(direct.status, allowed ? 200 : 403, `${identity} direct ${route} remote=${allowRemote}`);
          if (!allowed) assert.ok(!direct.text.includes('PRIVATE_REMOTE_TEXT'));
          const upstreamBefore = local.counts.upstream;
          const proxied = await local.request(route, { identity, fleet: true });
          assert.equal(proxied.status, identity !== 'read' && allowRemote ? 200 : 403);
          if (identity === 'read') assert.equal(local.counts.upstream, upstreamBefore);
          if (!(identity !== 'read' && allowRemote)) assert.ok(!proxied.text.includes('PRIVATE_REMOTE_TEXT'));
        }
        // Forbidden callers must not reach receive or acceptance; the enabled
        // direct/proxy admin paths above use their own registered questions.
        if (identity === 'read' || identity === 'admin' && !allowRemote) for (const [route, body] of writes) {
          const before = (await remote.snapshot()).receive;
          assert.equal((await remote.request(route, { identity, ...post(body) })).status, 403);
          const upstreamBefore = local.counts.upstream;
          assert.equal((await local.request(route, { identity, fleet: true, ...post(body) })).status, 403);
          assert.equal((await remote.snapshot()).receive, before);
          if (identity === 'read') assert.equal(local.counts.upstream, upstreamBefore);
        }
        if (identity !== 'cookie') for (const fleet of [false, true]) {
          const target = fleet ? local : remote;
          assert.equal((await target.request('/api/chat/settings', { identity, fleet, method: 'PUT', body: { allowRemote: !allowRemote } })).status, 403);
          assert.equal(remote.config.chat.allowRemote, allowRemote);
        }
      }
    }
  } finally { await remoteSandbox.close(); }
});

// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are read back; case teardown reclaims them.
registerIntegrationCase('single mode conversion retains both history tabs and rejects draft, send and answer APIs', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox);
  const active = await a.createConversation('multi history remains');
  const q = a.question(); a.addOutbound(active.draft.localId, questionContent(q));
  a.c4.insertConversation('in', 'telegram', 'external', 'external history remains', { groupName: 'external' });
  const transition = await a.convertToSingle();
  assert.equal(transition.target_mode, 'single');
  for (const tab of ['mine', 'external']) {
    const page = await a.request(`/api/chat/conversations?tab=${tab}`);
    assert.equal(page.status, 200); assert.equal(page.body.items.length, 1);
    const messages = await a.request(`/api/chat/conversations/${encodeURIComponent(page.body.items[0].id)}/messages?tab=${tab}`);
    assert.equal(messages.status, 200); assert.ok(messages.body.items.length >= 1);
  }
  const before = a.counts.receive;
  for (const [route, body] of [ ['/api/chat/drafts', {}], [active.route + '/send', { content: 'single prohibited' }], [active.route + '/answers', a.answer(q)] ]) {
    assert.equal((await a.request(route, post(body))).status, 403);
  }
  assert.equal(a.counts.receive, before);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_answers').get().n, 0);
  assert.equal(a.readMode(), 'single');
});

// Consumer outlets run for projection/reader/component changes. Only the same
// integration gate permits their private DB and child CLI setup.
// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are read back; case teardown reclaims them.
registerIntegrationCase('all model and history consumers project structured input before exposing it', async (t, sandbox) => {
  const { runConsumerCase } = await import('./helpers/chat-consumers.js');
  await runConsumerCase(t, sandbox);
});

// Run after harness/Core configuration changes; pure presentation may skip.
// Uses the same private runner/case proof above, with no DB or HTTP allocation.
// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are read back; case teardown reclaims them.
registerIntegrationCase('loaded Core data and skills paths cannot escape the proven test instance', async (t, sandbox) => {
  const proof = assertChatProcessIsolation(sandbox);
  assert.ok(proof.loadedRoot);
  assert.throws(() => assertChatProcessIsolation(sandbox, { env: { ...process.env, ZYLOS_DIR: '/tmp' } }), /Loaded Core instance/);
  assert.throws(() => assertChatProcessIsolation(sandbox, { skillsDir: '/tmp/other-instance/.claude/skills' }), /skills path/);
  assert.throws(() => assertChatProcessIsolation(sandbox, { dataDir: '/tmp/other-instance/comm-bridge' }), /data path/);
});

// Run for startup/history/question changes; CSS-only changes may skip. Uses
// private HTTP/C4/Dashboard DBs and actual startup formatting, with no runtime,
// checkpoint or unanswered-question adapter supplied to the startup loader.
// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DBs are read back; case teardown reclaims them.
registerIntegrationCase('startup loads delivered history without querying or injecting older unanswered questions', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox);
  const first = await a.createConversation('startup history original group');
  const question = a.question('single', 'unanswered-startup-sentinel');
  const row = a.addOutbound(first.draft.localId, questionContent(question));
  for (let index = 0; index < 7; index++) a.c4.insertConversation('in', 'dashboard', first.draft.localId,
    `startup ordinary tail ${index}`, { groupName: first.draft.localId });
  a.db.prepare("UPDATE conversations SET status='delivered' WHERE session_group=?").run(row.session_group);
  assert.equal(a.answers.question(row.session_group, question.interruptId).status, 'paused');
  assert.equal(a.c4.getCoverageEnd(row.session_group), 0, 'No checkpoint hides this pending question');
  const { emitC4Conversations } = await import('../../comm-bridge/scripts/c4-session-init.js');
  const { formatConversationsForAgent } = await import('../../comm-bridge/scripts/c4-db.js');
  const calls = [];
  const storage = new Proxy({
    getCoverageEnd: group => a.c4.getCoverageEnd(group),
    getDeliveredSince: (...args) => a.c4.getDeliveredSince(...args),
    formatConversationsForAgent,
  }, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `Startup attempted an unprovided query: ${String(key)}`);
    calls.push(key); return target[key];
  } });
  const startup = await emitC4Conversations({}, null, {
    withDb: async (_label, action) => action(storage),
    scopeReader: async () => ({ mode: 'multi', sessionGroup: row.session_group,
      scope: row.session_group, root: sandbox.paths.zylos, memoryDir: sandbox.paths.zylos + '/memory' }),
  });
  assert.equal(calls.join(','), 'getCoverageEnd,getDeliveredSince,formatConversationsForAgent');
  assert.ok(startup.includes('startup ordinary tail 6'));
  assert.ok(startup.includes('reply via:'));
  assert.equal(startup.includes(question.interruptId), false);
  assert.equal(startup.includes(question.questionSummary), false);
  assert.equal(a.answers.question(row.session_group, question.interruptId).status, 'paused');
});

// Boundary: real AuthGate/receive/history/upload/download, local and two-process
// FleetProxy. Run for attachment storage/routes/protocol; unrelated UI may skip.
// Each case owns private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DBs via the harness.
for (const fleet of [false, true]) attachmentCase(`${fleet ? 'fleet' : 'local'} image and file messages preserve target bytes and mixed agent references`, async (t, sandbox) => {
  const target = fleet ? await createRemoteChatApiFixture(t, createChatSandbox(t)) : await createChatApiFixture(t, sandbox);
  const hub = fleet ? await createChatApiFixture(t, sandbox) : target;
  if (fleet) {
    assert.equal((await target.request('/api/chat/settings', { method: 'PUT', body: { allowRemote: true } })).status, 200);
    hub.setProxy(target);
  }
  const api = fleet ? {
    request: (route, options) => hub.request(route, { ...options, fleet: true }),
    rawRequest: (route, options) => hub.rawRequest(route, { ...options, fleet: true }),
  } : target;
  const current = await attachmentDraft(api);
  const png = fixturePng(8, 8), text = Buffer.from('isolated target report\n');
  const image = await uploadAttachment(api, current.route, png, { name: 'picture.png', mime: 'image/png' });
  const file = await uploadAttachment(api, current.route, text);
  assert.equal(image.status, 201); assert.equal(file.status, 201);
  assert.equal((await api.rawRequest(`${current.route}/attachments/${image.body.id}`)).status, 404);
  if (fleet) {
    // The target sees the fleet key, never either browser's local cookie.
    assert.equal((await sendAttachments(target, current.route, [file.body.id], 'target cookie rejected')).status, 404);
    const other = await attachmentDraft(api);
    assert.equal((await sendAttachments(api, other.route, [file.body.id], 'cross-group rejected')).status, 404);
    hub.store.insertSession(attachmentDigest('second-private-fleet-browser'), Date.now());
    const shared = await hub.rawRequest(current.route + '/send', { fleet: true, method: 'POST', headers: {
      cookie: '__Secure-zylos_dashboard_session=second-private-fleet-browser', 'content-type': 'application/json',
    }, body: JSON.stringify({ content: '', attachments: [image.body.id, file.body.id] }) });
    assert.equal(shared.status, 200); assert.equal((await shared.json()).stored, true);
  }
  const sent = await sendAttachments(api, current.route, [image.body.id, file.body.id]);
  assert.equal(sent.status, 200); assert.equal(sent.body.stored, true);
  const route = attachmentRoute(sent.body.conversationId);
  const mixed = await sendAttachments(api, route, [file.body.id], 'mixed text and attachment');
  assert.equal(mixed.status, 200); assert.equal(mixed.body.stored, true);
  const history = await api.request(route + '/messages?tab=mine');
  assert.equal(history.status, 200);
  const user = history.body.items.find(row => row.id === sent.body.messageId);
  assert.equal(user.attachments.length, 2); assert.ok(user.attachments.every(item => item.available));
  assert.equal(history.body.items.find(row => row.id === mixed.body.messageId).attachments[0].id, file.body.id);
  const register = async (name, kind, bytes) => {
    if (fleet) return target.registerAttachment(current.draft.localId, name, kind, bytes.toString('base64'));
    const directory = path.join(sandbox.paths.zylos, 'workspace'); fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, name); fs.writeFileSync(filename, bytes);
    return target.attachments.register(current.draft.localId, { kind, path: filename });
  };
  const registeredImage = await register('answer.png', 'image', png);
  const registeredFile = await register('answer.txt', 'file', text);
  const envelope = { version: 1, kind: 'message', messageId: 'attachment-mixed-reply', fallbackText: 'Image and file reply', blocks: [
    { id: 'text', type: 'markdown', schemaVersion: 1, data: { text: 'Actual target copies' } },
    ...[[registeredImage, 'image'], [registeredFile, 'file']].map(([record, kind]) => ({ id: kind, type: `x-zylos.${kind}`, schemaVersion: 1,
      fallbackText: record.name, data: { attachmentId: record.attachmentId, nameSnapshot: record.name } })),
  ] };
  const reply = await target.addOutbound(current.draft.localId, questionContent(envelope));
  const refreshed = await api.request(route + '/messages?tab=mine');
  const output = refreshed.body.items.find(row => row.id === reply.id);
  assert.equal(output.attachments.length, 2); assert.ok(output.attachments.every(item => item.available));
  for (const [id, bytes] of [[image.body.id, png], [file.body.id, text], [registeredImage.attachmentId, png], [registeredFile.attachmentId, text]]) {
    await assertAttachmentBytes(api, route, id, bytes);
  }
});

// Boundary: unlinked IDs bind to upload principal and group, linked IDs to
// current authorized group. Run for identity/attachment access; CSS may skip.
// Runner and sandbox prove private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DBs.
attachmentCase('cookie and API key principals cannot cross groups or unlinked ownership', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox);
  a.config.chat.allowRemote = true;
  const first = await a.createConversation(), second = await a.createConversation();
  const token = 'zylos_st_' + '9'.repeat(64);
  const key = a.store.insertApiKey({ name: 'other-admin', keyHash: 'private-other-key', scope: 'admin' });
  a.store.insertApiSession({ tokenHash: attachmentDigest(token), apiKeyId: key.lastInsertRowid, scope: 'admin', createdAt: Date.now(), expiresAt: Date.now() + 600000 });
  a.tokens.other = token;
  const cookie = await uploadAttachment(a, first.route);
  const api = await uploadAttachment(a, first.route, Buffer.from('API principal'), { identity: 'admin' });
  assert.equal(cookie.status, 201); assert.equal(api.status, 201);
  for (const [route, id, identity] of [
    [second.route, cookie.body.id, 'cookie'], [second.route, api.body.id, 'admin'],
    [first.route, cookie.body.id, 'admin'], [first.route, api.body.id, 'cookie'], [first.route, api.body.id, 'other'],
  ]) {
    const denied = await sendAttachments(a, route, [id], 'denied', { identity });
    assert.equal(denied.status, 404);
  }
  assert.equal((await sendAttachments(a, first.route, [api.body.id], 'same key', { identity: 'admin' })).body.stored, true);
  assert.equal((await sendAttachments(a, first.route, [cookie.body.id], 'same cookie')).body.stored, true);
  await assertAttachmentBytes(a, first.route, api.body.id, Buffer.from('API principal'), { identity: 'other' });
  assert.equal((await a.rawRequest(`${second.route}/attachments/${api.body.id}`, { identity: 'admin' })).status, 404);
  assert.equal((await a.rawRequest(`${first.route}/attachments/${api.body.id}`, { identity: 'read' })).status, 403);
});

// Boundary: unreferenced physical copies expire at 30 minutes, not 25. Run
// for collection/window changes; unrelated rendering may skip. Private harness.
attachmentCase('unsent upload expires for sending at twenty-five minutes and deletes its file at thirty', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const record = await uploadAttachment(a, active.route); assert.equal(record.status, 201);
  const filename = a.attachments.resolve(active.draft.localId, record.body.id);
  let clock = Date.now(); a.attachments.now = () => clock;
  const created = savedAttachment(a, record.body.id).created_at;
  clock = created + ATTACHMENT_SEND_WINDOW_MS - 1;
  assert.equal(a.attachments.prepareSend(active.draft, [record.body.id], savedAttachment(a, record.body.id).principal).length, 1);
  clock++;
  assert.equal((await sendAttachments(a, active.route, [record.body.id])).status, 404);
  clock = created + ATTACHMENT_TTL_MS - 1; await a.attachments.gc(); assert.equal(fs.existsSync(filename), true);
  clock++; await a.attachments.gc(); assert.equal(fs.existsSync(filename), false);
  assert.equal(savedAttachment(a, record.body.id), undefined);
});

// Boundary: existing authoritative references outlive login/TTL/window and
// same ID links to multiple messages. Run for history/GC; UI-only may skip.
// Private fixture; timestamp backfill uses existing schema, no product clock.
attachmentCase('multiple message references survive login renewal and thirty-minute collection', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const bytes = Buffer.from('permanent linked copy');
  const uploaded = await uploadAttachment(a, active.route, bytes); assert.equal(uploaded.status, 201);
  for (const text of ['first reference', 'second reference']) {
    const sent = await sendAttachments(a, active.route, [uploaded.body.id], text);
    assert.equal(sent.status, 200); assert.equal(sent.body.stored, true);
  }
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_attachment_messages WHERE attachment_id=?').get(uploaded.body.id).n, 2);
  expireAttachment(a, uploaded.body.id, ATTACHMENT_TTL_MS * 2); await a.attachments.gc();
  a.store.insertSession(attachmentDigest('renewed-private-cookie'), Date.now());
  const options = { headers: { cookie: '__Secure-zylos_dashboard_session=renewed-private-cookie' } };
  await assertAttachmentBytes(a, active.route, uploaded.body.id, bytes, options);
  const page = await a.request(active.route + '/messages?tab=mine');
  assert.equal(page.body.items.filter(row => row.attachments.some(item => item.id === uploaded.body.id && item.available)).length, 2);
  assert.equal((await a.rawRequest(`${active.route}/attachments/${uploaded.body.id}`, { identity: 'none' })).status, 401);
});

// Boundary: linked row committed but callback lost; history repairs without
// an extra receive. Run for sender/history association; rendering may skip.
// Private sandbox and DBs; controlled receive adapter loses only its receipt.
attachmentCase('lost post-insert receipt is repaired by history without automatic resend', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const record = await uploadAttachment(a, active.route); assert.equal(record.status, 201);
  a.setInvoke(async args => { await a.realReceive(args); throw Error('private receipt lost after committed insert'); });
  const before = a.counts.receive;
  const sent = await sendAttachments(a, active.route, [record.body.id], 'receipt loss');
  assert.equal(sent.status, 200); assert.equal(a.counts.receive, before + 1);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_attachment_messages WHERE attachment_id=?').get(record.body.id).n, 0);
  const history = await a.request(active.route + '/messages?tab=mine');
  assert.ok(history.body.items.some(row => row.attachments.some(item => item.id === record.body.id && item.available)));
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_attachment_messages WHERE attachment_id=?').get(record.body.id).n, 1);
  for (let i = 0; i < 2; i++) await a.request(active.route + '/status');
  assert.equal(a.counts.receive, before + 1);
});

// Boundary: >200 relevant rows after fixed registration watermark require
// multiple GC passes. Run for GC/history queries; unrelated UI may skip.
// Private harness. Bounded 205-row fixture asserts counts, never a large diff.
attachmentCase('collection continues multiple pages after its fixed watermark before retaining a late reference', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const record = await uploadAttachment(a, active.route); assert.equal(record.status, 201);
  const saved = savedAttachment(a, record.body.id);
  for (let index = 0; index < 205; index++) a.c4.insertConversation('in', 'dashboard', active.draft.localId, `bounded filler ${index}`, { groupName: active.draft.localId });
  const content = buildAnnotatedContent('', a.attachments.prepareSend(active.draft, [record.body.id], saved.principal));
  const reference = a.c4.insertConversation('in', 'dashboard', active.draft.localId, content, { groupName: active.draft.localId });
  let clock = saved.created_at + ATTACHMENT_TTL_MS; a.attachments.now = () => clock;
  await a.attachments.gc();
  const partial = savedAttachment(a, record.body.id);
  assert.ok(partial.scanned_c4_id > saved.c4_watermark); assert.ok(partial.scanned_c4_id < reference.id);
  assert.equal(partial.scan_upper_id, reference.id); assert.equal(partial.next_check_at, clock + ATTACHMENT_GC_INTERVAL_MS);
  assert.equal(fs.existsSync(a.attachments.resolve(active.draft.localId, record.body.id)), true);
  clock += ATTACHMENT_GC_INTERVAL_MS; await a.attachments.gc();
  assert.equal(a.store.db.prepare('SELECT c4_id FROM chat_attachment_messages WHERE attachment_id=?').get(record.body.id).c4_id, reference.id);
  assert.equal(savedAttachment(a, record.body.id).scan_upper_id, reference.id);
});

// Boundary: Core lookup failure must defer deletion, then a later scan may
// finish. Run for GC/recovery; unrelated UI may skip. Private DB and media.
attachmentCase('collection lookup failure preserves the physical copy for the next check', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const uploaded = await uploadAttachment(a, active.route); assert.equal(uploaded.status, 201);
  const filename = a.attachments.resolve(active.draft.localId, uploaded.body.id);
  let clock = savedAttachment(a, uploaded.body.id).created_at + ATTACHMENT_TTL_MS;
  a.attachments.now = () => clock; a.setLookupUnavailable(true); await a.attachments.gc();
  assert.equal(fs.existsSync(filename), true); assert.ok(savedAttachment(a, uploaded.body.id));
  assert.equal(savedAttachment(a, uploaded.body.id).next_check_at, clock + ATTACHMENT_GC_INTERVAL_MS);
  a.setLookupUnavailable(false); clock += ATTACHMENT_GC_INTERVAL_MS; await a.attachments.gc();
  assert.equal(fs.existsSync(filename), false); assert.equal(savedAttachment(a, uploaded.body.id), undefined);
});

// Boundary: directory orphan cleanup follows mtime and preserves live record
// copies. Run for GC/filesystem changes; UI-only may skip. Private media only.
attachmentCase('directory sweep deletes old orphan final and partial files but preserves fresh files', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox);
  const old = ['orphan-final.bin', 'orphan-part.bin.part'];
  for (const name of [...old, 'fresh.part']) fs.writeFileSync(path.join(a.attachments.mediaDir, name), 'orphan fixture');
  const aged = new Date(Date.now() - ATTACHMENT_TTL_MS - 1000);
  for (const name of old) fs.utimesSync(path.join(a.attachments.mediaDir, name), aged, aged);
  await a.attachments.gc();
  for (const name of old) assert.equal(fs.existsSync(path.join(a.attachments.mediaDir, name)), false);
  assert.equal(fs.existsSync(path.join(a.attachments.mediaDir, 'fresh.part')), true);
});

// Boundary: accepted >5-minute validate-to-insert gap can race expiry GC.
// Run for attachment windows/receive sequencing; unrelated UI may skip.
// Private DB timestamp backfill and receive barrier, no product time changes.
attachmentCase('validation followed by more than five minutes before insert can leave an unavailable attachment', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const uploaded = await uploadAttachment(a, active.route); assert.equal(uploaded.status, 201);
  let clock = savedAttachment(a, uploaded.body.id).created_at;
  a.attachments.now = () => clock;
  clock += ATTACHMENT_SEND_WINDOW_MS - 1;
  let entered = false;
  a.setInvoke(async args => {
    entered = true; clock += ATTACHMENT_GC_INTERVAL_MS + 2;
    await a.attachments.gc(); assert.equal(savedAttachment(a, uploaded.body.id), undefined);
    return a.realReceive(args);
  });
  const sent = await sendAttachments(a, active.route, [uploaded.body.id], 'delayed receive');
  assert.equal(entered, true); assert.equal(sent.status, 200); assert.equal(sent.body.stored, true);
  const history = await a.request(active.route + '/messages?tab=mine');
  const row = history.body.items.find(item => item.id === sent.body.messageId);
  assert.equal(row.attachments.length, 1); assert.equal(row.attachments[0].available, false);
  assert.equal((await a.rawRequest(`${active.route}/attachments/${uploaded.body.id}`)).status, 404);
});

// Boundary: target remote permission revoked while multipart writer is active.
// Run for attachment authorization/stream cleanup; UI-only may skip. Private
// loopback request/socket/media/DB; case cleanup owns unfinished requests.
for (const fleet of [false, true]) attachmentCase(`${fleet ? 'fleet' : 'local'} permission closure rejects an ongoing upload and removes its partial file`, async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  a.config.chat.allowRemote = true;
  const gateway = fleet ? await createRemoteChatApiFixture(t, createChatSandbox(t)) : null;
  if (gateway) await gateway.setProxy(a);
  const base = gateway ? gateway.base + '/fleet/Remote' : a.base;
  const authentication = gateway ? { cookie: `__Secure-zylos_dashboard_session=${gateway.cookie}` } : { authorization: `Bearer ${a.tokens.admin}` };
  const boundary = 'private-upload-revocation';
  const opening = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ongoing.txt"\r\nContent-Type: text/plain\r\n\r\n`;
  const ending = `\r\n--${boundary}--\r\n`;
  const request = http.request(base + active.route + '/uploads', { method: 'POST', headers: {
    ...authentication, origin: gateway?.base || a.base, 'content-type': `multipart/form-data; boundary=${boundary}`,
  } });
  sandbox.addCleanup(() => request.destroy());
  const response = new Promise((resolve, reject) => {
    request.once('response', res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.once('end', () => resolve({ status: res.statusCode, body })); res.once('error', reject); });
    request.once('error', reject);
  });
  const before = a.counts.receive;
  request.write(opening); request.write(Buffer.alloc(65536, 'x'));
  const deadline = Date.now() + 3000;
  while (!fs.readdirSync(a.attachments.mediaDir).some(name => name.endsWith('.part'))) {
    assert.ok(Date.now() < deadline, 'Private multipart writer started'); await delay(10);
  }
  a.config.chat.allowRemote = false; request.end(ending);
  const result = await response; assert.equal(result.status, 403); assert.ok(result.body.includes('remote_chat_disabled'));
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 0);
  assert.equal(fs.readdirSync(a.attachments.mediaDir).length, 0); assert.equal(a.counts.receive, before);
  a.config.chat.allowRemote = true;
  assert.equal((await uploadAttachment(a, active.route, Buffer.from('allowed control'), { identity: 'admin' })).status, 201);
});

// Boundary: already-started binary response must abort, never complete with a
// short successful body, after target permission closes. Run for streaming or
// access changes; UI-only may skip. Private bounded 20 MiB file and HTTP socket.
for (const fleet of [false, true]) attachmentCase(`${fleet ? 'fleet' : 'local'} permission closure aborts an ongoing download instead of returning a successful short body`, async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  a.config.chat.allowRemote = true;
  const gateway = fleet ? await createRemoteChatApiFixture(t, createChatSandbox(t)) : null;
  if (gateway) await gateway.setProxy(a);
  const base = gateway ? gateway.base + '/fleet/Remote' : a.base;
  const authentication = gateway ? { cookie: `__Secure-zylos_dashboard_session=${gateway.cookie}` } : { authorization: `Bearer ${a.tokens.admin}` };
  // Exceed both relay legs' socket buffers so pausing the browser leaves the
  // target stream active until its next authorization check.
  const bytes = Buffer.alloc(20 * 1024 * 1024, 'd');
  const uploaded = await uploadAttachment(a, active.route, bytes, { identity: 'admin', name: 'large.bin', mime: 'application/octet-stream' });
  assert.equal(uploaded.status, 201);
  assert.equal((await sendAttachments(a, active.route, [uploaded.body.id], 'large download', { identity: 'admin' })).body.stored, true);
  const request = http.get(base + `${active.route}/attachments/${uploaded.body.id}`, { headers: authentication });
  sandbox.addCleanup(() => request.destroy());
  const [response] = await once(request, 'response');
  assert.equal(response.statusCode, 200);
  response.pause();
  let received = 0, failed = false;
  response.on('data', chunk => { received += chunk.length; });
  const completion = new Promise(resolve => {
    response.once('error', () => { failed = true; });
    response.once('close', resolve);
  });
  await delay(1100); a.config.chat.allowRemote = false; response.resume(); await completion;
  assert.equal(failed, true); assert.equal(response.complete, false); assert.ok(received < bytes.length);
  a.config.chat.allowRemote = true; await assertAttachmentBytes(a, active.route, uploaded.body.id, bytes, { identity: 'admin' });
});

// Boundary: rejected upload/send and uncertain committed receive are not retry
// triggers. Run for failure/recovery semantics; unrelated UI may skip. Private
// HTTP and DB with controlled Core receipt only, no native runtime or network.
attachmentCase('upload and send failures never schedule a second receive or replay uploaded bytes', async (t, sandbox) => {
  const a = await createChatApiFixture(t, sandbox), active = await a.createConversation();
  const before = a.counts.receive;
  const rejected = await uploadAttachment(a, active.route, Buffer.from('not authorized'), { identity: 'read' });
  assert.equal(rejected.status, 403);
  const uploaded = await uploadAttachment(a, active.route); assert.equal(uploaded.status, 201);
  a.setInvoke(async () => { throw Error('private failure before insert'); });
  const failed = await sendAttachments(a, active.route, [uploaded.body.id], 'unknown result');
  assert.equal(failed.status, 200); assert.equal(a.counts.receive, before + 1);
  for (const suffix of ['/status', '/messages?tab=mine', '/status']) await a.request(active.route + suffix);
  assert.equal(a.counts.receive, before + 1);
  assert.equal(a.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, 1);
  assert.equal(a.db.prepare("SELECT COUNT(*) n FROM conversations WHERE direction='in' AND content LIKE '%unknown result%'").get().n, 0);
});
