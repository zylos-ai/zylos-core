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
