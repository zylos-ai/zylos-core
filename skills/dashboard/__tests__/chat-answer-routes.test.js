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

const protocol = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const envelope = name => structuredClone(protocol.valid.find(item => item.name === name).envelope);
const group = 'dashboard-owned:local-chat';
const conversationId = `g:${Buffer.from(group).toString('hex').toUpperCase()}`;

const error = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });

// Boundary: actual HTTP route, AuthGate and conditional Dashboard transactions.
// Run for answer routes, authorization, body validation or question-page
// changes; unrelated UI edits may skip. Default delivery is a narrow adapter
// spy; recovery cases inject the real two-database delivery fixture. Every
// case owns its temporary SQLite DB, loopback listener and auth cleanup timer;
// no Core process, external network, tmux, PM2 or model runs here.
async function fixture(t, { engine, question } = {}) {
  const sessionGroup = question?.sessionGroup ?? group;
  const expectedId = `g:${Buffer.from(sessionGroup).toString('hex').toUpperCase()}`;
  const targetRoute = `/api/conversations/${encodeURIComponent(expectedId)}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-answer-http-'));
  const store = engine?.store ?? new Store(path.join(root, 'dashboard.db'));
  const answers = engine?.answers ?? new ChatAnswers({ store });
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
      if (id !== expectedId) throw error('chat_conversation_forbidden', 403);
      await onResolve?.();
      return { channel: 'dashboard', namespace: sessionGroup.split(':')[0], localId: question?.endpointId ?? 'local-chat',
        sessionGroup, state };
    },
  };
  const delivery = engine?.delivery ?? {
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
    if (!engine) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(suffix, { method = 'POST', body = {}, identity = 'cookie', origin = base, target = targetRoute } = {}) {
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

// Bound-but-unactivated records cannot answer an established question.
// Run when write eligibility changes; unrelated UI work may skip.

// Reconciliation is async; revoking remote access before the response must
// prevent previously authorized question data from escaping in that response.

// Boundary: real Dashboard/C4 files and receive, private HTTP and AuthGate.
// Run for saved-action projection/retry changes; skip presentation-only edits.
// The delivery fixture owns both databases; the HTTP fixture owns its listener
// and auth timer. No live PM2, tmux, runtime, model or external network is used.

// Boundary: corrupted saved JSON must be isolated even for unresolved receipts,
// whose group refresh reads the accepted answer before projecting the page.
// Uses the same private real-store/receive fixture; no receive call is needed.
