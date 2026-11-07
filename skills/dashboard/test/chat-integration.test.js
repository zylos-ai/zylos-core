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
import { setTimeout as delay } from 'node:timers/promises';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture, createRemoteChatApiFixture, questionContent, assertChatProcessIsolation } from './helpers/chat-integration-api.js';
import { acceptDelivery } from '../src/lib/chat/channel.js';
import { makeQuestionSummary, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

const conditionalFixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));

let assertionCount = 0;
const assert = new Proxy(strictAssert, { get(target, key) {
  const value = Reflect.get(target, key);
  return typeof value === 'function' ? (...args) => { assertionCount++; return value(...args); } : value;
} });

const enabled = chatEnabled();
const options = { skip: !enabled, timeout: 45000 };
const post = body => ({ method: 'POST', body });

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
      assert.deepEqual(result.body, { error: 'invalid_chat_answer' });
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
