import { catchUpConversation } from './helpers/conversation-stream-catchup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { loadingFixture, deferred, flush } from './helpers/conversation-loading-fixture.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { createConversationState } = await import('../public/js/wb/conversation-state.js');
// Real controller and bounded fake clock/request adapters only; no HTTP/DB/tmux/PM2.
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key]?.startsWith(runnerRoot + path.sep), key);
console.info('loading guard isolation', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))), 'no HTTP/DB/tmux/PM2');
const question = name => ({ c4Id: 2, interruptId: name, status: 'paused' });
const options = { timeout: 2000 };

for (const settle of ['resolve', 'reject']) test(`a quiet list poll releases an overlapping foreground refresh before its stale ${settle}`, options, async t => {
  const pending = deferred(); let lists = 0;
  const f = loadingFixture(t, createConversationState, url => {
    if (url.pathname !== '/api/chat/conversations') return;
    if (++lists === 2) return pending.promise;
    return { items: [{ id: 'g:AA', displayName: lists >= 3 ? 'Latest list' : 'Initial list' }], nextCursor: null };
  });
  await f.open(); const manual = f.state.refresh(); await flush();
  assert.equal(f.state.snapshot().loading, true);
  await f.advance(30000);
  assert.ok(lists >= 3);
  assert.equal(f.state.snapshot().loading, false);
  if (settle === 'resolve') pending.resolve({ items: [{ id: 'g:BB', displayName: 'Stale list' }], nextCursor: null });
  else pending.reject({ code: 'stale_list_failure' });
  await manual;
  assert.equal(f.state.snapshot().loading, false);
  assert.equal(f.state.snapshot().error, null);
  assert.equal(f.state.snapshot().items[0].displayName, 'Latest list');
  assert.equal(f.state.snapshot().canCreate, true);
});

for (const entry of ['initial', 'manual']) test(`a quiet message-triggered question refresh releases the overlapping ${entry} question loader`, options, async t => {
  const pending = deferred(); let questionReads = 0;
  const target = entry === 'initial' ? 1 : 2;
  const f = loadingFixture(t, createConversationState, url => {
    if (url.pathname.endsWith('/questions')) {
      if (++questionReads === target) return pending.promise;
      return { items: [question('fresh')], nextCursor: null };
    }
    if (url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'after') return {
      items: [{ id: 2, direction: 'out', status: 'delivered', content: 'new question' }], afterCursor: 'after2', nextCursor: null
    };
  });
  let foreground;
  if (entry === 'initial') { await f.state.open(); foreground = f.state.select('g:AA'); await flush(); }
  else { await f.open(); foreground = f.state.refreshQuestions(); await flush(); }
  assert.equal(f.state.snapshot().questionsLoading, true);
  if (entry === 'initial') { await f.visible(false); await f.visible(true); }
  else await f.advance(5000);
  assert.ok(questionReads > target);
  assert.equal(f.state.snapshot().questionsLoading, false);
  pending.resolve({ items: [question('stale')], nextCursor: null }); await foreground;
  assert.equal(f.state.snapshot().questionsLoading, false);
  assert.equal(f.state.snapshot().questions.some(row => row.interruptId === 'stale'), false);
  assert.equal(f.state.snapshot().questions.some(row => row.interruptId === 'fresh'), true);
});

test('an old identity foreground list cannot clear a newer identity loading owner', options, async t => {
  const old = deferred(), latest = deferred(); let lists = 0;
  const f = loadingFixture(t, createConversationState, url => url.pathname === '/api/chat/conversations' ? ++lists === 1 ? old.promise : latest.promise : undefined);
  const first = f.state.open(); await flush();
  f.state.close(); f.setIdentity('remote'); const second = f.state.open(); await flush();
  old.resolve({ items: [{ id: 'g:BB' }], nextCursor: null }); await first;
  assert.equal(f.state.snapshot().loading, true);
  latest.resolve({ items: [{ id: 'g:AA' }], nextCursor: null }); await second;
  assert.equal(f.state.snapshot().loading, false);
  assert.equal(f.state.snapshot().items[0].id, 'g:AA');
});

test('a foreground list releases its loader while a newer quiet list is still pending', options, async t => {
  const foreground = deferred(), quiet = deferred(); let lists = 0;
  const f = loadingFixture(t, createConversationState, url => {
    if (url.pathname !== '/api/chat/conversations') return;
    if (++lists === 2) return foreground.promise;
    if (lists === 3) return quiet.promise;
  });
  await f.open(); const manual = f.state.refresh(); await flush();
  await f.advance(30000); assert.equal(lists, 3);
  foreground.resolve({ items: [{ id: 'g:BB' }], nextCursor: null }); await manual;
  assert.equal(f.state.snapshot().loading, false);
  assert.equal(f.state.snapshot().items[0].id, 'g:AA', 'stale foreground data is ignored');
  quiet.resolve({ items: [{ id: 'g:AA', displayName: 'Fresh' }], nextCursor: null }); await flush();
  assert.equal(f.state.snapshot().items[0].displayName, 'Fresh');
});

test('a foreground question read releases its loader while a newer quiet read is still pending', options, async t => {
  const foreground = deferred(), quiet = deferred(); let reads = 0;
  const f = loadingFixture(t, createConversationState, url => {
    if (url.pathname.endsWith('/questions')) {
      if (++reads === 2) return foreground.promise;
      if (reads === 3) return quiet.promise;
    }
    if (url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'after') return {
      items: [{ id: 2, direction: 'out', status: 'delivered', content: 'question' }], afterCursor: 'after2', nextCursor: null
    };
  });
  await f.open(); const manual = f.state.refreshQuestions(); await flush();
  await f.advance(5000); assert.equal(reads, 3);
  foreground.resolve({ items: [question('stale')], nextCursor: null }); await manual;
  assert.equal(f.state.snapshot().questionsLoading, false);
  assert.equal(f.state.snapshot().questions.some(row => row.interruptId === 'stale'), false);
  quiet.resolve({ items: [question('fresh')], nextCursor: null }); await flush();
  assert.equal(f.state.snapshot().questions.some(row => row.interruptId === 'fresh'), true);
});

test('an older foreground list cannot release the loading owner of a newer tab list', options, async t => {
  const older = deferred(), newer = deferred(); let lists = 0;
  const f = loadingFixture(t, createConversationState, url => {
    if (url.pathname !== '/api/chat/conversations') return;
    if (++lists === 2) return older.promise;
    if (lists === 3) return newer.promise;
  });
  await f.open(); const first = f.state.refresh(); await flush();
  const second = f.state.setTab('external'); await flush();
  assert.equal(lists, 3); assert.equal(f.state.snapshot().loading, true);
  older.resolve({ items: [{ id: 'g:OLD' }], nextCursor: null }); await first;
  assert.equal(f.state.snapshot().loading, true, 'new tab still owns its pending foreground loader');
  assert.equal(f.state.snapshot().tab, 'external');
  assert.equal(f.state.snapshot().items.length, 0, 'old tab response remains ignored');
  newer.resolve({ items: [{ id: 'g:NEW' }], nextCursor: null }); await second;
  assert.equal(f.state.snapshot().loading, false);
  assert.equal(f.state.snapshot().items[0].id, 'g:NEW');
});

test('an older foreground question read cannot release a newer foreground loading owner', options, async t => {
  const older = deferred(), newer = deferred(); let reads = 0;
  const f = loadingFixture(t, createConversationState, url => {
    if (!url.pathname.endsWith('/questions')) return;
    if (++reads === 2) return older.promise;
    if (reads === 3) return newer.promise;
  });
  await f.open(); const first = f.state.refreshQuestions(); await flush();
  const second = f.state.refreshQuestions(); await flush();
  assert.equal(reads, 3); assert.equal(f.state.snapshot().questionsLoading, true);
  older.resolve({ items: [question('stale')], nextCursor: null }); await first;
  assert.equal(f.state.snapshot().questionsLoading, true, 'new foreground request still owns its loader');
  assert.equal(f.state.snapshot().questions.some(row => row.interruptId === 'stale'), false);
  newer.resolve({ items: [question('fresh')], nextCursor: null }); await second;
  assert.equal(f.state.snapshot().questionsLoading, false);
  assert.equal(f.state.snapshot().questions.some(row => row.interruptId === 'fresh'), true);
});

test('a stale foreground question error cannot overwrite a newer successful result', options, async t => {
  const older = deferred(); let reads = 0;
  const f = loadingFixture(t, createConversationState, url => {
    if (!url.pathname.endsWith('/questions')) return;
    if (++reads === 2) return older.promise;
    return { items: [question('fresh')], nextCursor: null };
  });
  await f.open(); const first = f.state.refreshQuestions(); await flush();
  await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().questionError, null);
  older.reject({ code: 'stale_question_failure' }); await first;
  assert.equal(f.state.snapshot().questionError, null, 'superseded question errors remain ignored');
  assert.equal(f.state.snapshot().questionsLoading, false);
  assert.equal(f.state.snapshot().questions.some(row => row.interruptId === 'fresh'), true);
  assert.equal(f.state.snapshot().blocked, false);
});

test('a detail name cannot replace the name just returned by the list', options, async t => {
  let changed = false;
  const f = loadingFixture(t, createConversationState, url => {
    if (url.pathname === '/api/chat/conversations') return {
      items: [{ id: 'g:AA', displayName: changed ? 'Latest list name' : 'Initial name' }], nextCursor: null
    };
    if (decodeURIComponent(url.pathname) === '/api/chat/conversations/g:AA') return {
      conversation: { id: 'g:AA', state: 'active', displayName: changed ? 'Older detail name' : 'Initial name' }
    };
  });
  await f.open(); changed = true;
  await catchUpConversation(f.state);
  assert.equal(f.state.snapshot().items[0].displayName, 'Latest list name');
  assert.equal(f.state.snapshot().conversation.displayName, 'Latest list name');
});

test('a list completed during an off-page detail read keeps its newer name', options, async t => {
  const detail = deferred(); let phase = 'initial';
  const f = loadingFixture(t, createConversationState, url => {
    if (url.pathname === '/api/chat/conversations') return {
      items: phase === 'detail' ? [] : [{ id: 'g:AA', displayName: phase === 'latest' ? 'Latest list name' : 'Initial name' }],
      nextCursor: phase === 'detail' ? 'next-page' : null
    };
    if (decodeURIComponent(url.pathname) === '/api/chat/conversations/g:AA') return phase === 'initial'
      ? { conversation: { id: 'g:AA', state: 'active', displayName: 'Initial name' } } : detail.promise;
  });
  await f.open(); phase = 'detail';
  const polling = catchUpConversation(f.state); await flush();
  try {
    phase = 'latest'; await f.state.loadMore();
    assert.equal(f.state.snapshot().items[0].displayName, 'Latest list name');
  } finally {
    detail.resolve({ conversation: { id: 'g:AA', state: 'active', displayName: 'Older detail name' } });
    await polling;
  }
  assert.equal(f.state.snapshot().items[0].displayName, 'Latest list name');
  assert.equal(f.state.snapshot().conversation.displayName, 'Latest list name');
});

test('a manual rename during an off-page detail read keeps the user name', options, async t => {
  const detail = deferred(); let waiting = false;
  const f = loadingFixture(t, createConversationState, (url, request) => {
    if (url.pathname === '/api/chat/conversations') return {
      items: waiting ? [] : [{ id: 'g:AA', displayName: 'Initial name' }], nextCursor: null
    };
    if (decodeURIComponent(url.pathname) === '/api/chat/conversations/g:AA') {
      if (request?.method === 'PATCH') return { conversation: { id: 'g:AA', state: 'active', displayName: request.body.displayName } };
      return waiting ? detail.promise : { conversation: { id: 'g:AA', state: 'active', displayName: 'Initial name' } };
    }
  });
  await f.open(); waiting = true;
  const polling = catchUpConversation(f.state); await flush();
  try { await f.state.rename('Human name'); }
  finally {
    detail.resolve({ conversation: { id: 'g:AA', state: 'active', displayName: 'Older detail name' } });
    await polling;
  }
  assert.equal(f.state.snapshot().items[0].displayName, 'Human name');
  assert.equal(f.state.snapshot().conversation.displayName, 'Human name');
});
