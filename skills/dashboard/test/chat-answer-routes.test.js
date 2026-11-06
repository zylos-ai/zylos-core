import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { AuthGate } from '../src/lib/auth.js';
import { ChatAnswers } from '../src/lib/chat/answers.js';
import { handleChatAnswers } from '../src/lib/chat/answer-routes.js';
import { sendJson } from '../src/lib/http.js';
import { parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

const protocol = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const envelope = name => structuredClone(protocol.valid.find(item => item.name === name).envelope);
const group = 'dashboard-owned:local-chat';
const conversationId = `g:${Buffer.from(group).toString('hex').toUpperCase()}`;
const route = `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
const error = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });

// Boundary: actual HTTP route, AuthGate and conditional Dashboard transactions.
// Run for answer routes, authorization, body validation or question-page
// changes; unrelated UI edits may skip. Delivery is a narrow adapter spy: actual
// receive and C4 authority are covered by chat-answer-delivery.test.js. Every
// case owns its temporary SQLite DB, loopback listener and auth cleanup timer;
// no Core process, external network, tmux, PM2 or model runs here.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-answer-http-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  const answers = new ChatAnswers({ store });
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = 'isolated-answer-cookie';
  const tokens = { read: `zylos_st_${'a'.repeat(64)}`, admin: `zylos_st_${'b'.repeat(64)}` };
  const authStore = {
    getSession: hash => hash === digest(cookie) ? { created_at: Date.now(), last_activity_at: Date.now() } : null,
    touchSession() {}, deleteSession() {}, cleanupSessions() {}, cleanupExpiredApiSessions() {},
    getApiSession(hash) {
      const scope = Object.keys(tokens).find(key => hash === digest(tokens[key]));
      return scope ? { api_key_id: scope, scope, expires_at: Date.now() + 60_000 } : null;
    },
  };
  const config = { auth: { enabled: true, password: 'scrypt:fixture' }, chat: { allowRemote: false } };
  const auth = new AuthGate(config, authStore);
  let mode = 'multi', state = 'active', onResolve, beforeDelivery, onReconcile, reconciliationPages = false, serial = 0;
  const calls = { deliveries: [], reconciliations: [] };
  const receipts = new Map();
  const sender = {
    async resolve(id) {
      if (id !== conversationId) throw error('chat_conversation_forbidden', 403);
      await onResolve?.();
      return { channel: 'dashboard', namespace: 'dashboard-owned', localId: 'local-chat',
        sessionGroup: group, state };
    },
  };
  const delivery = {
    async deliver(answerId, { initial, retry, authorize }) {
      // Model the real adapter's successful pre-call absence check before its
      // awaited Core loading/authorization boundary; no C4 is queried here.
      store.db.prepare("UPDATE chat_answer_deliveries SET state='not_stored' WHERE answer_id=? AND state='pending'").run(answerId);
      await beforeDelivery?.();
      const denied = await authorize();
      if (denied) throw error(denied.error, denied.status);
      calls.deliveries.push({ answerId, initial, retry });
      if (!receipts.has(answerId)) receipts.set(answerId, { answerId, stored: null,
        deliveryState: 'pending_reconciliation', retryAllowed: false });
      return receipts.get(answerId);
    },
    async reconcileGroup(sessionGroup, options) {
      await onReconcile?.();
      calls.reconciliations.push({ sessionGroup, ...options });
      for (const [answerId, saved] of receipts) receipts.set(answerId, { ...saved, stored: true, deliveryState: 'pending' });
      return { items: [], nextCursor: reconciliationPages && !options.afterAnswerId ? 'after-first-batch' : null };
    },
    receipt(answerId) { return receipts.get(answerId); },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (await auth.handle(req, res, url)) return;
      if (await handleChatAnswers(req, res, url, { auth, config, answers, delivery, sender, readMode: () => mode })) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (failure) { sendJson(res, 500, { error: failure.message }); }
  });
  t.after(async () => {
    clearInterval(auth._cleanupTimer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(suffix, { method = 'POST', body = {}, identity = 'cookie', origin = base, target = route } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (origin !== null) headers.origin = origin;
    if (identity === 'cookie') headers.cookie = `__Secure-zylos_dashboard_session=${cookie}`;
    else if (tokens[identity]) headers.authorization = `Bearer ${tokens[identity]}`;
    const response = await fetch(base + target + suffix, { method, headers, signal: AbortSignal.timeout(5000),
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  function seed(name = 'single', changes = {}) {
    const saved = { ...envelope(name), ...changes };
    const c4Id = String(++serial);
    store.db.prepare(`INSERT INTO chat_questions(c4_id,session_group,endpoint_id,message_id,interrupt_id,question_summary,constraints)
      VALUES(?,?,?,?,?,?,?)`).run(c4Id, group, 'local-chat', saved.messageId, saved.interruptId, saved.questionSummary,
      JSON.stringify({ block: saved.blocks.find(block => block.id === saved.interrupt.blockId), interrupt: saved.interrupt }));
    return saved;
  }
  function answer(question, id = 'http_answer') {
    const action = envelope(question.blocks[0].type === 'confirmation' ? 'answer_cancel' : 'answer_single_select').action;
    action.id = id;
    action.context = { ...action.context, messageId: question.messageId, conversationId };
    return { interruptId: question.interruptId, action };
  }
  return { request, seed, answer, answers, store, config, calls,
    count: table => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    setMode: value => { mode = value; }, setOnResolve: value => { onResolve = value; },
    setBeforeDelivery: value => { beforeDelivery = value; }, setReconciliationPages: value => { reconciliationPages = value; },
    setState: value => { state = value; }, setOnReconcile: value => { onReconcile = value; } };
}

test('answer routes reject read keys, closed remote access, foreign origins and single mode before acceptance', async t => {
  const f = await fixture(t), question = f.seed(), body = f.answer(question);
  for (const options of [{ identity: 'read' }, { identity: 'admin' }, { origin: 'https://outside.invalid' }, { origin: null }]) {
    assert.equal((await f.request('/answers', { ...options, body })).status, 403);
  }
  f.config.chat.allowRemote = true;
  assert.equal((await f.request('/answers', { identity: 'read', body })).status, 403);
  f.setMode('single');
  assert.equal((await f.request('/answers', { body })).status, 403);
  assert.equal(f.count('chat_answers'), 0);
  assert.equal(f.count('chat_answer_deliveries'), 0);
  assert.equal(f.count('chat_question_controls'), 0);
  assert.equal(f.calls.deliveries.length, 0);
  assert.equal(f.answers.question(group, question.interruptId).status, 'paused');
});

test('answer acceptance uses the stored question and repeated action IDs reuse one durable result', async t => {
  const f = await fixture(t), question = f.seed(), body = f.answer(question);
  const first = await f.request('/answers', { body });
  assert.equal(first.status, 200);
  assert.equal(first.body.answer.sessionGroup, group);
  assert.equal(first.body.answer.endpointId, 'local-chat');
  const parsed = parseC4Content(first.body.answer.content).envelope;
  assert.equal(parsed.questionSummary, question.questionSummary);
  assert.equal(parsed.metadata.zylos.answerId, body.action.id);
  assert.equal(parsed.fallbackText, `回答了 interruptId=${question.interruptId}（问题：${question.questionSummary}）：方案甲`);
  assert.equal(f.answers.question(group, question.interruptId).status, 'answered');
  const repeated = await f.request('/answers', { body: { ...body, retry: true } });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.answer, first.body.answer);
  assert.equal(f.count('chat_answers'), 1);
  assert.equal(f.count('chat_answer_deliveries'), 1);
  assert.deepEqual(f.calls.deliveries, [
    { answerId: body.action.id, initial: true, retry: false },
    { answerId: body.action.id, initial: false, retry: true },
  ]);
  const changed = structuredClone(body); changed.action.payload.selected = ['b'];
  assert.equal((await f.request('/answers', { body: changed })).status, 409);
  assert.equal(f.calls.deliveries.length, 2);
});

test('malformed answers and forged summary or routing fields cannot accept or deliver an answer', async t => {
  const f = await fixture(t), question = f.seed(), body = f.answer(question);
  for (const invalid of [null, [], '{broken', {}, { ...body, retry: 'true' }, { ...body, action: [] }]) {
    assert.equal((await f.request('/answers', { body: invalid })).status, 400);
  }
  for (const field of ['questionSummary', 'sessionGroup', 'channel', 'endpointId', 'namespace', 'localId', 'conversationId']) {
    assert.equal((await f.request('/answers', { body: { ...body, [field]: 'forged' } })).status, 400, field);
  }
  const foreignContext = structuredClone(body); foreignContext.action.context.conversationId = 'g:666F726569676E';
  assert.equal((await f.request('/answers', { body: foreignContext })).status, 400);
  const invalidChoice = structuredClone(body); invalidChoice.action.payload.selected = ['unregistered'];
  assert.equal((await f.request('/answers', { body: invalidChoice })).status, 400);
  assert.equal((await f.request('/answers', { body, target: '/api/chat/conversations/foreign' })).status, 403);
  assert.equal((await f.request('/answers', { body: { ...body, interruptId: 'foreign_interrupt' } })).status, 404);
  assert.equal((await f.request('/answers?channel=other', { body })).status, 400);
  assert.equal((await f.request('/answers', { method: 'GET' })).status, 405);
  assert.equal(f.count('chat_answers'), 0);
  assert.equal(f.count('chat_answer_deliveries'), 0);
  assert.equal(f.calls.deliveries.length, 0);
  assert.equal(f.answers.question(group, question.interruptId).status, 'paused');
});

test('remote admin answers require the instance switch and authorization is rechecked after asynchronous resolution', async t => {
  const f = await fixture(t), question = f.seed(), body = f.answer(question);
  f.config.chat.allowRemote = true;
  f.setOnResolve(async () => { await Promise.resolve(); f.setMode('single'); });
  assert.equal((await f.request('/answers', { identity: 'admin', body })).status, 403);
  assert.equal(f.count('chat_answers'), 0);
  assert.equal(f.calls.deliveries.length, 0);
  f.setOnResolve(null); f.setMode('multi');
  assert.equal((await f.request('/answers', { identity: 'admin', body })).status, 200);
  assert.equal(f.count('chat_answers'), 1);
  assert.equal(f.calls.deliveries.length, 1);
});

test('delivery receives a live authorization callback and denied delivery retains the checked absent answer', async t => {
  const f = await fixture(t), question = f.seed();
  f.setBeforeDelivery(async () => { await Promise.resolve(); f.setMode('single'); });
  assert.equal((await f.request('/answers', { body: f.answer(question) })).status, 403);
  assert.equal(f.count('chat_answers'), 1);
  assert.equal(f.count('chat_answer_deliveries'), 1);
  assert.equal(f.store.db.prepare('SELECT state FROM chat_answer_deliveries').get().state, 'not_stored');
  assert.equal(f.calls.deliveries.length, 0);
});

test('question pages show lifecycle and delivery overlays while every refresh reconciles the original group', async t => {
  const f = await fixture(t);
  const first = f.seed('single', { messageId: 'first_question', interruptId: 'a_question' });
  const next = f.seed('single', { messageId: 'next_question', interruptId: 'b_question' });
  assert.equal((await f.request('/answers', { body: f.answer(first) })).status, 200);
  f.setReconciliationPages(true);
  const page = await f.request('/questions?limit=1', { method: 'GET' });
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.items[0].status, 'answered');
  assert.equal(page.body.items[0].delivery.stored, true);
  assert.equal(page.body.items[0].delivery.deliveryState, 'pending');
  assert.equal(page.body.nextCursor, first.interruptId);
  assert.deepEqual(f.calls.reconciliations, [
    { sessionGroup: group, limit: 100, afterAnswerId: '' },
    { sessionGroup: group, limit: 100, afterAnswerId: 'after-first-batch' },
  ]);
  f.setReconciliationPages(false);
  const second = await f.request(`/questions?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`, { method: 'GET' });
  assert.equal(second.status, 200);
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.items[0].interrupt_id, next.interruptId);
  assert.equal(second.body.items[0].status, 'paused');
  assert.equal(Object.hasOwn(second.body.items[0], 'delivery'), false);
  assert.equal(second.body.nextCursor, null);
  assert.equal(f.calls.reconciliations.length, 3);
  assert.equal(f.calls.deliveries.length, 1, 'refreshing questions cannot dispatch an answer');
  for (const query of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?foreign=value']) {
    assert.equal((await f.request('/questions' + query, { method: 'GET' })).status, 400);
  }
  assert.equal((await f.request('/questions', { method: 'GET', identity: 'admin' })).status, 403);
  f.config.chat.allowRemote = true;
  assert.equal((await f.request('/questions', { method: 'GET', identity: 'read' })).status, 403);
});

test('confirmation cancel is an accepted answer and cannot become a stop control', async t => {
  const f = await fixture(t), question = f.seed('confirmation');
  const response = await f.request('/answers', { body: f.answer(question) });
  assert.equal(response.status, 200);
  assert.equal(response.body.answer.action.payload.outcome, 'cancel');
  assert.equal(f.answers.question(group, question.interruptId).status, 'answered');
  assert.equal(f.count('chat_question_controls'), 0);
  assert.equal(f.count('chat_answers'), 1);
});

// Bound-but-unactivated records cannot answer an established question.
// Run when write eligibility changes; unrelated UI work may skip.
test('a bound draft cannot accept answers through the conversation API', async t => {
  const f = await fixture(t), question = f.seed();
  f.setState('draft');
  assert.equal((await f.request('/answers', { body: f.answer(question) })).status, 403);
  assert.equal(f.count('chat_answers'), 0);
  assert.equal(f.count('chat_question_controls'), 0);
  assert.equal(f.calls.deliveries.length, 0);
});

// Reconciliation is async; revoking remote access before the response must
// prevent previously authorized question data from escaping in that response.
test('remote access is checked again after asynchronous answer reconciliation', async t => {
  const f = await fixture(t); f.seed(); f.config.chat.allowRemote = true;
  f.setOnReconcile(async () => { await Promise.resolve(); f.config.chat.allowRemote = false; });
  const result = await f.request('/questions', { method: 'GET', identity: 'admin' });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'remote_chat_disabled');
  assert.equal(Object.hasOwn(result.body, 'items'), false);
  assert.equal(f.calls.deliveries.length, 0);
});
