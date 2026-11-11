import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 4000 }, fn);
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const text = await import('../public/js/wb/chat-compose-text.js');
const { createComposeDraftStore, createDraftStore, validComposeDraft, MAX_COMPOSE_DRAFT_BYTES } = await import('../public/js/wb/chat-drafts.js');
const { createConversationState } = await import('../public/js/wb/conversation-state.js');
const { annotationRange, textIndex, annotatable } = await import('../public/js/wb/chat-annotations.js');

// Pure browser modules only: in-memory storage, fake request functions and clock; no HTTP, database, PM2 or tmux.
class Storage {
  data = new Map();
  failWrites = false;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { if (this.failWrites) throw new Error('QuotaExceededError'); this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const TZ = 'Asia/Shanghai', NOW = new Date('2026-11-11T08:00:00Z');
// 14:32 on 11-11 in the instance time zone (UTC+8).
const AT_1432 = '2026-11-11T06:32:00Z';

test('composed content matches the §2.7.4 example verbatim', () => {
  const content = text.composeContent({
    text: '  第一批只放 2 台是不是太保守了？另外回滚这块再展开说说：撤回一批大概要多久？\n',
    timeZone: TZ, now: NOW,
    annotations: [
      { messageId: '1532', direction: 'out', timestamp: AT_1432, excerpt: '灰度只影响一小部分实例，出问题时撤回这一批即可。', length: 24, comment: '撤回具体怎么操作？要停服务吗？' },
      { messageId: '1532', direction: 'out', timestamp: AT_1432, excerpt: '资源占用：蓝绿要同时保留两套完整环境，机器翻倍。\n验证方式：灰度可以先放 5% 的流量观察错误率和延迟，再逐步放大。', length: 58, comment: '我们一共 4 台，5% 怎么落到实例上？' },
    ],
  });
  assert.equal(text.storedContent(content, '1534'), [
    '[quote c4_id=1534]',
    '第一批只放 2 台是不是太保守了？另外回滚这块再展开说说：撤回一批大概要多久？',
    '',
    '【标注 2 条】原消息都在本对话里，c4_id 是消息编号。',
    '1. AI · 11-11 14:32 · c4_id=1532',
    '   原文：「灰度只影响一小部分实例，出问题时撤回这一批即可。」',
    '   批注：撤回具体怎么操作？要停服务吗？',
    '2. AI · 11-11 14:32 · c4_id=1532',
    '   原文：「资源占用：蓝绿要同时保留两套完整环境，机器翻倍。',
    '   验证方式：灰度可以先放 5% 的流量观察错误率和延迟，再逐步放大。」',
    '   批注：我们一共 4 台，5% 怎么落到实例上？',
  ].join('\n'));
});

test('annotations without own words open with the fixed line; an empty comment has no comment line', () => {
  const item = { messageId: '7', direction: 'in', timestamp: AT_1432, excerpt: '我的原话', length: 4, comment: '' };
  for (const own of ['', '  \n ']) {
    assert.equal(text.composeContent({ text: own, annotations: [item, { ...item, messageId: '8' }], timeZone: TZ, now: NOW }), [
      '请看下面我标注的 2 处内容，有批注的请逐条回应。',
      '',
      '【标注 2 条】原消息都在本对话里，c4_id 是消息编号。',
      '1. 我 · 11-11 14:32 · c4_id=7',
      '   原文：「我的原话」',
      '2. 我 · 11-11 14:32 · c4_id=8',
      '   原文：「我的原话」',
    ].join('\n'));
  }
});

test('multi-line excerpts and comments are indented, so no line can pose as an attachment annotation', () => {
  const excerpt = '第一行\n[attachment:file id="x" name="a.txt" size=1]\n\n  \n最后', comment = '批注一\n[attachment:image id="y" name="b.png" size=2]';
  const content = text.composeContent({ text: '看看', annotations: [{ messageId: '9', direction: 'out', timestamp: AT_1432, excerpt, length: 30, comment }], timeZone: TZ, now: NOW });
  assert.equal(content.split('\n').slice(3).join('\n'), [
    '1. AI · 11-11 14:32 · c4_id=9',
    '   原文：「第一行',
    '   [attachment:file id="x" name="a.txt" size=1]',
    '',
    '',
    '   最后」',
    '   批注：批注一',
    '   [attachment:image id="y" name="b.png" size=2]',
  ].join('\n'));
  for (const line of content.split('\n')) assert.ok(!line.startsWith('[attachment:'), line);
});

test('excerpts over 4000 characters are cut and say the full length', () => {
  const long = '字'.repeat(4500);
  const content = text.composeContent({ text: 'x', annotations: [{ messageId: '3', direction: 'out', timestamp: AT_1432, excerpt: long, length: 4500, comment: '' }], timeZone: TZ, now: NOW });
  const line = content.split('\n').find(value => value.startsWith('   原文'));
  assert.equal(line, `   原文（前 4000 字，全文 4500 字，可按 c4_id 查）：「${'字'.repeat(4000)}」`);
  // A stored excerpt is already cut; its recorded length still names the full selection. Characters, not UTF-16 units.
  const emoji = text.composeContent({ text: 'x', annotations: [{ messageId: '3', direction: 'out', timestamp: AT_1432, excerpt: '😀'.repeat(4000), length: 4001, comment: '' }], timeZone: TZ, now: NOW });
  assert.match(emoji, /原文（前 4000 字，全文 4001 字，可按 c4_id 查）：「😀{4000}」/u);
  const exact = text.composeContent({ text: 'x', annotations: [{ messageId: '3', direction: 'out', timestamp: AT_1432, excerpt: '😀'.repeat(4000), length: 4000, comment: '' }], timeZone: TZ, now: NOW });
  assert.match(exact, /\n {3}原文：「😀{4000}」$/u);
});

test('plain messages without annotations are sent exactly as typed', () => {
  assert.equal(text.composeContent({ text: '  hello\n', annotations: [] }), '  hello\n');
  assert.equal(text.storedContent('hi', null), 'hi');
  assert.equal(text.storedContent('hi', '12'), '[quote c4_id=12]\nhi');
});

test('annotation and quote stamps follow the instance time zone and show other years', () => {
  assert.equal(text.annotationStamp('2026-11-10T16:05:00Z', TZ, NOW), '11-11 00:05');
  assert.equal(text.annotationStamp('2026-11-10T16:05:00Z', 'UTC', NOW), '11-10 16:05');
  assert.equal(text.annotationStamp('2025-12-31T23:00:00Z', TZ, NOW), '01-01 07:00', 'already this year in the instance zone');
  assert.equal(text.annotationStamp('2025-12-31T15:00:00Z', TZ, NOW), '2025-12-31 23:00');
  assert.equal(text.shortStamp(AT_1432, TZ, NOW), '14:32');
  assert.equal(text.shortStamp('2026-11-10T10:05:00Z', TZ, NOW), '11-10 18:05');
  assert.equal(text.shortStamp('not a time', TZ, NOW), '');
});

test('readable text drops the quote marker and attachment lines and names the attachments', () => {
  const row = { direction: 'in', content: '[quote c4_id=5]\n看这个\n[attachment:file id="f1" name="plan.pdf" size=10]', attachments: [{ name: 'plan.pdf' }] };
  assert.equal(text.readableText(row), '看这个\n（附件：plan.pdf）');
  assert.equal(text.readableText({ channel: 'internal', content: 'raw', internal: { content: '  转发的话 ' } }), '转发的话');
  assert.equal(text.previewLine('a\n  b\n\nc', 3), 'a b');
  const split = text.splitQuoteMarker('[quote c4_id=5]\nbody');
  assert.deepEqual(split, { quoteId: '5', body: 'body' });
  assert.deepEqual(text.splitQuoteMarker('[quote c4_id=05]\nbody'), { quoteId: null, body: '[quote c4_id=05]\nbody' });
  // The page hides the marker only when the server described the quote; an old server's row keeps the text.
  assert.equal(text.displayRow({ content: '[quote c4_id=5]\nbody', quote: { id: 5 } }).content, 'body');
  assert.equal(text.displayRow({ content: '[quote c4_id=5]\nbody' }).content, '[quote c4_id=5]\nbody');
  assert.equal(text.displayRow({ content: '[quote c4_id=5]\nbody', quote: { id: 6 } }).content, '[quote c4_id=5]\nbody');
  assert.equal(text.contentBytes('字a'), 4);
});

const scope = (extra = {}) => ({ authRoot: 'https://example.test/dashboard', instance: 'https://example.test/dashboard', conversationId: 'g:A', ...extra });
const draft = (extra = {}) => ({ text: 'hello', quote: { id: '12', direction: 'out', timestamp: AT_1432, text: 'reply' },
  annotations: [{ key: 1, messageId: '12', direction: 'out', timestamp: AT_1432, excerpt: 'abc', length: 3, comment: '', part: 0, start: 0, end: 3 }],
  seq: 1, pending: null, ...extra });

test('compose drafts round-trip per login root, instance and conversation', () => {
  const storage = new Storage(), store = createComposeDraftStore({ storage });
  assert.deepEqual(store.save(scope(), draft()), { saved: true });
  assert.deepEqual(store.load(scope()), draft());
  assert.equal(store.load(scope({ conversationId: 'g:B' })), null);
  assert.equal(store.load(scope({ instance: 'https://example.test/dashboard/fleet/Peer' })), null);
  assert.equal(store.load(scope({ authRoot: 'https://other.test/' })), null);
  assert.equal(store.load({ authRoot: 'x', instance: 'y' }), null);
  // An empty draft removes the stored copy.
  assert.deepEqual(store.save(scope(), { text: '', quote: null, annotations: [], seq: 1, pending: null }), { saved: true });
  assert.equal(storage.length, 0);
});

test('oversized or unstorable drafts stay in memory only and drop the older stored copy', () => {
  const storage = new Storage(), store = createComposeDraftStore({ storage });
  store.save(scope(), draft());
  assert.deepEqual(store.save(scope(), draft({ text: 'x'.repeat(MAX_COMPOSE_DRAFT_BYTES) })), { saved: false, reason: 'oversize' });
  assert.equal(store.load(scope()), null);
  store.save(scope(), draft());
  storage.failWrites = true;
  assert.deepEqual(store.save(scope(), draft({ text: 'changed' })), { saved: false, reason: 'storage' });
  assert.equal(store.load(scope()), null);
  const broken = createComposeDraftStore({ storage: () => { throw new Error('SecurityError'); } });
  assert.deepEqual(broken.save(scope(), draft()), { saved: false, reason: 'storage' });
  assert.equal(broken.load(scope()), null);
  assert.equal(broken.remove(scope()), false);
});

test('stored drafts with an unexpected shape are ignored', () => {
  const storage = new Storage(), store = createComposeDraftStore({ storage });
  store.save(scope(), draft());
  const key = storage.key(0);
  for (const bad of [
    { text: 1 }, { quote: { id: '0', direction: 'out', timestamp: '', text: '' } }, { quote: { id: '1', direction: 'sideways', timestamp: '', text: '' } },
    { annotations: Array.from({ length: 21 }, (_, i) => ({ ...draft().annotations[0], key: i + 1 })) },
    { annotations: [{ ...draft().annotations[0], end: 0 }] }, { pending: { content: 'x', quote: 'abc', answered: false } }, { seq: 1.5 },
  ]) {
    assert.equal(validComposeDraft(draft(bad)), false, JSON.stringify(bad));
    storage.data.set(key, JSON.stringify({ scope: scope(), draft: draft(bad) }));
    assert.equal(store.load(scope()), null);
  }
  storage.data.set(key, '{not json');
  assert.equal(store.load(scope()), null);
});

test('clearing a login root or instance also removes its compose drafts', () => {
  const storage = new Storage(), compose = createComposeDraftStore({ storage }), forms = createDraftStore({ storage });
  const peer = scope({ instance: 'https://example.test/dashboard/fleet/Peer' }), other = scope({ authRoot: 'https://other.test/', instance: 'https://other.test/' });
  for (const value of [scope(), peer, other]) compose.save(value, draft());
  storage.setItem('foreign', 'keep');
  forms.clearInstance({ authRoot: scope().authRoot, instance: peer.instance });
  assert.equal(compose.load(peer), null);
  assert.ok(compose.load(scope()));
  forms.clearAuthRoot(scope().authRoot);
  assert.equal(compose.load(scope()), null);
  assert.ok(compose.load(other));
  assert.equal(storage.getItem('foreign'), 'keep');
});

test('annotation offsets map to a range over the message text nodes, and stale text draws nothing', () => {
  // A minimal tree: two paragraphs, the first with an inline element. Block ends read as one line break.
  const textNode = data => ({ nodeType: 3, data, childNodes: [] });
  const el = (nodeName, ...children) => { const node = { nodeType: 1, nodeName, childNodes: children }; for (const child of children) child.parentNode = node; return node; };
  const a = textNode('hello '), b = textNode('world'), c = textNode('second');
  const part = el('DIV', el('P', a, el('STRONG', b)), el('P', c));
  const index = textIndex(part);
  assert.equal(index.text, 'hello world\nsecond\n');
  const article = { querySelectorAll: () => [part] };
  part.closest = () => article;
  const root = { querySelector: selector => selector === 'article[data-message-id="12"]' ? article : null };
  const document = { createRange: () => { const range = { setStart(node, offset) { range.start = [node, offset]; }, setEnd(node, offset) { range.end = [node, offset]; } }; return range; } };
  const item = { messageId: '12', part: 0, start: 3, end: 14, excerpt: 'lo world\nse', length: 11 };
  const range = annotationRange({ document, root, item });
  assert.deepEqual(range.start, [a, 3]);
  assert.deepEqual(range.end, [c, 2]);
  assert.equal(annotationRange({ document, root, item: { ...item, excerpt: 'lo world\nsX' } }), null);
  assert.equal(annotationRange({ document, root, item: { ...item, length: 12 } }), null);
  assert.equal(annotationRange({ document, root, item: { ...item, messageId: '13' } }), null);
  assert.equal(annotationRange({ document, root, item: { ...item, part: 1 } }), null);
});

function stateFixture({ storage = new Storage(), send = () => ({ stored: true, conversationId: 'g:A', deliveryState: 'pending' }), status = null } = {}) {
  const calls = [];
  let time = Date.parse('2026-11-11T08:00:00Z');
  const state = createConversationState({
    document: { hidden: false, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    composeDrafts: createComposeDraftStore({ storage }),
    draftScope: () => ({ authRoot: scope().authRoot, instance: scope().instance }),
    now: () => time, setTimeout: () => 0, clearTimeout() {},
    request: async (path, options) => {
      calls.push({ path, options });
      const u = new URL(path, 'http://fixture');
      if (path === '/api/session-mode') return { data: { sessionMode: 'multi' } };
      if (u.pathname === '/api/chat/conversations') return { items: [{ id: 'g:A' }, { id: 'g:B' }], nextCursor: null, tz: TZ };
      if (u.pathname.endsWith('/send')) return send(options.body);
      if (u.pathname.endsWith('/messages')) return { items: [], nextCursor: null, afterCursor: 'a', tz: TZ };
      if (u.pathname.endsWith('/questions')) return { items: [], nextCursor: null };
      if (u.pathname.endsWith('/status')) return { items: [] };
      const id = decodeURIComponent(u.pathname.split('/').at(-1));
      return { conversation: { id, state: 'active' }, conversationId: id, stored: false, ...(status?.() ?? {}) };
    },
  });
  const sends = () => calls.filter(call => call.path.endsWith('/send')).map(call => call.options.body);
  return { state, storage, calls, sends, advance: ms => { time += ms; } };
}
const quoteOf = (id = '12') => ({ id, direction: 'out', timestamp: AT_1432, text: 'the reply' });
const annotation = (extra = {}) => ({ messageId: '12', direction: 'out', timestamp: AT_1432, excerpt: 'abc', length: 3, comment: '', part: 0, start: 0, end: 3, ...extra });
async function opened(options) {
  const f = stateFixture(options);
  await f.state.open();
  await f.state.select('g:A');
  await flush();
  assert.equal(f.state.snapshot().canWrite, true);
  return f;
}

test('a quote alone is not sendable; text with a quote sends the quote id and clears the stored draft', async () => {
  const f = await opened();
  assert.equal(f.state.setQuote(quoteOf()), true);
  await f.state.send();
  assert.deepEqual(f.sends(), []);
  assert.equal(f.state.setQuote(quoteOf('13')), true, 'a new quote replaces the old one');
  assert.equal(f.state.snapshot().quote.id, '13');
  f.state.setInput('why?');
  assert.equal(f.storage.length, 1);
  await f.state.send();
  assert.deepEqual(f.sends(), [{ content: 'why?', quote: 13 }]);
  const s = f.state.snapshot();
  assert.equal(s.input, '');
  assert.equal(s.quote, null);
  assert.equal(s.pending, null);
  assert.equal(f.storage.length, 0);
  f.state.destroy();
});

test('annotations are sendable without text and are composed after the user words', async () => {
  const f = await opened();
  assert.equal(f.state.addAnnotation(annotation()), true);
  await f.state.send();
  assert.equal(f.sends()[0].content, '请看下面我标注的 1 处内容，有批注的请逐条回应。\n\n【标注 1 条】原消息都在本对话里，c4_id 是消息编号。\n1. AI · 11-11 14:32 · c4_id=12\n   原文：「abc」');
  assert.equal(Object.hasOwn(f.sends()[0], 'quote'), false);
  assert.deepEqual(f.state.snapshot().annotations, []);
  f.state.destroy();
});

test('annotations are limited to 20, keyed, editable and removable one by one or all at once', async () => {
  const f = await opened();
  for (let i = 0; i < 20; i++) assert.equal(f.state.addAnnotation(annotation({ comment: String(i) })), true);
  assert.equal(f.state.addAnnotation(annotation()), false);
  const keys = f.state.snapshot().annotations.map(item => item.key);
  assert.deepEqual(keys, Array.from({ length: 20 }, (_, i) => i + 1));
  f.state.updateAnnotation(3, 'edited');
  assert.equal(f.state.snapshot().annotations[2].comment, 'edited');
  f.state.removeAnnotation(3);
  assert.equal(f.state.snapshot().annotations.length, 19);
  assert.equal(f.state.addAnnotation(annotation()), true);
  assert.equal(f.state.snapshot().annotations.at(-1).key, 21, 'keys are never reused');
  f.state.removeAnnotation();
  assert.deepEqual(f.state.snapshot().annotations, []);
  f.state.destroy();
});

test('content over 65536 bytes with its quote line is not sent and the draft stays', async () => {
  const f = await opened();
  f.state.setQuote(quoteOf());
  f.state.setInput('a'.repeat(65536 - '[quote c4_id=12]\n'.length + 1));
  await f.state.send();
  assert.deepEqual(f.sends(), []);
  f.state.setInput('a'.repeat(65536 - '[quote c4_id=12]\n'.length));
  await f.state.send();
  assert.equal(f.sends().length, 1);
  f.state.destroy();
});

test('a not-stored answer leaves the whole draft editable', async () => {
  const f = await opened({ send: () => ({ stored: false, conversationId: 'g:A', preserveInput: true, retryAllowed: true, error: 'chat_send_failed' }) });
  f.state.setQuote(quoteOf());
  f.state.addAnnotation(annotation());
  f.state.setInput('words');
  await f.state.send();
  const s = f.state.snapshot();
  assert.equal(s.pending, null);
  assert.equal(s.input, 'words');
  assert.equal(s.quote.id, '12');
  assert.equal(s.annotations.length, 1);
  assert.equal(f.state.setQuote(null), true, 'the composer is editable again');
  f.state.destroy();
});

test('an open outcome locks the draft and a retry resends the identical content and quote', async () => {
  let answer = { stored: null, conversationId: 'g:A', retryAllowed: true, needsReconciliation: true };
  let read = null;
  const f = await opened({ send: () => answer, status: () => read });
  f.state.setQuote(quoteOf());
  f.state.addAnnotation(annotation({ comment: 'why' }));
  f.state.setInput('first words');
  await f.state.send();
  assert.equal(f.state.snapshot().retryRequired, true);
  assert.deepEqual(f.state.snapshot().pending.quote, '12');
  assert.equal(f.state.setQuote(null), false);
  assert.equal(f.state.addAnnotation(annotation()), false);
  assert.equal(f.state.updateAnnotation(1, 'other'), false);
  assert.equal(f.state.removeAnnotation(), false);
  // Even a later minute (a stamp could change) and changed text do not alter the retried content.
  f.advance(24 * 3600 * 1000);
  f.state.setInput('changed');
  answer = { stored: true, conversationId: 'g:A', deliveryState: 'pending' };
  await f.state.send({ retry: true });
  const [first, second] = f.sends();
  assert.deepEqual(second, { ...first, retry: true });
  assert.equal(f.state.snapshot().pending, null);
  f.state.destroy();
});

test('a status read settles an answered open outcome: stored clears, not stored unlocks', async () => {
  for (const [stored, cleared] of [[true, true], [false, false]]) {
    let read = null;
    const f = await opened({ send: () => ({ stored: null, conversationId: 'g:A', retryAllowed: false }), status: () => read });
    f.state.setQuote(quoteOf());
    f.state.setInput('words');
    await f.state.send();
    assert.ok(f.state.snapshot().pending);
    read = { stored, retryAllowed: !stored };
    await f.state.refreshStatus();
    const s = f.state.snapshot();
    assert.equal(s.pending, null);
    assert.equal(s.quote === null, cleared);
    assert.equal(f.storage.length, cleared ? 0 : 1);
    f.state.destroy();
  }
});

test('a status read during a retry in flight leaves the draft locked until the retry answers', async () => {
  let release, answer = { stored: null, conversationId: 'g:A', retryAllowed: true, needsReconciliation: true };
  let read = null;
  const f = await opened({ send: () => answer, status: () => read });
  f.state.setInput('words');
  await f.state.send();
  assert.ok(f.state.snapshot().pending);
  answer = new Promise(resolve => { release = resolve; });
  const retry = f.state.send({ retry: true });
  await flush();
  assert.equal(f.state.snapshot().sending, true);
  read = { stored: false, retryAllowed: true };
  await f.state.refreshStatus();
  assert.equal(f.state.snapshot().pending?.content, 'words', 'a read taken while the retry is in flight cannot describe the retry');
  assert.equal(f.state.setQuote(quoteOf()), false);
  release({ stored: true, conversationId: 'g:A', deliveryState: 'pending' });
  await retry;
  f.state.destroy();
});

test('a status read without a known outcome keeps the draft locked', async () => {
  for (const read of [{ stored: null, retryAllowed: true }, { stored: undefined, retryAllowed: true }]) {
    let current = null;
    const f = await opened({ send: () => ({ stored: null, conversationId: 'g:A', retryAllowed: true }), status: () => current });
    f.state.setQuote(quoteOf());
    f.state.setInput('words');
    await f.state.send();
    current = read;
    await f.state.refreshStatus();
    const s = f.state.snapshot();
    assert.deepEqual(s.pending && { content: s.pending.content, quote: s.pending.quote }, { content: 'words', quote: '12' });
    assert.equal(f.state.setQuote(null), false);
    f.state.destroy();
  }
});

test('a lost send that a status read reports stored keeps the draft: the read may describe an earlier message', async () => {
  let read = null;
  const f = await opened({ send: () => { throw new TypeError('network down'); }, status: () => read });
  f.state.setQuote(quoteOf());
  f.state.setInput('words');
  await f.state.send();
  assert.ok(f.state.snapshot().pending, 'no answer: the outcome is open');
  read = { stored: true, retryAllowed: false };
  await f.state.refreshStatus();
  const s = f.state.snapshot();
  assert.equal(s.pending, null);
  assert.equal(s.input, 'words');
  assert.equal(s.quote.id, '12');
  assert.equal(f.storage.length, 1);
  f.state.destroy();
});

test('a refused send unlocks the draft; a send without any answer keeps it for a retry', async () => {
  const refused = Object.assign(new Error('invalid_chat_quote'), { status: 400, code: 'invalid_chat_quote' });
  const f = await opened({ send: () => { throw refused; } });
  f.state.setQuote(quoteOf());
  f.state.setInput('words');
  await f.state.send();
  let s = f.state.snapshot();
  assert.equal(s.pending, null);
  assert.equal(s.retryRequired, false);
  assert.equal(s.input, 'words');
  assert.equal(f.state.setQuote(null), true, 'the draft can be changed after a refusal');
  f.state.destroy();
  const lost = await opened({ send: () => { throw new TypeError('network down'); } });
  lost.state.setInput('words');
  await lost.state.send();
  s = lost.state.snapshot();
  assert.equal(s.retryRequired, true);
  assert.equal(s.pending.content, 'words');
  assert.equal(lost.state.setQuote(quoteOf()), false);
  lost.state.destroy();
});

test('a draft conversation moves its stored draft to the id its first send returns', async () => {
  const storage = new Storage();
  const f = stateFixture({ storage, send: () => ({ stored: null, conversationId: 'g:N', retryAllowed: true, needsReconciliation: true }) });
  await f.state.open();
  await f.state.select('d:new');
  await flush();
  f.state.setQuote(quoteOf());
  f.state.setInput('first');
  const keys = () => [...storage.data.keys()].map(key => JSON.parse(key.slice(key.indexOf(':') + 1)).at(-1));
  assert.deepEqual(keys(), ['d:new']);
  await f.state.send();
  assert.deepEqual(keys(), ['g:N']);
  assert.equal(f.state.snapshot().selectedId, 'g:N');
  assert.equal(f.state.snapshot().pending.content, 'first');
  f.state.destroy();
});

test('internal messages and locked composers cannot be annotated', () => {
  const article = internal => ({ classList: { contains: name => internal && name === 'conversation-internal' } });
  const writable = { tab: 'mine', canWrite: true, sending: false, pending: null };
  assert.equal(annotatable(article(false), writable), true);
  assert.equal(annotatable(article(true), writable), false);
  for (const locked of [{ tab: 'external' }, { canWrite: false }, { sending: true }, { pending: { content: 'x', quote: null } }]) {
    assert.equal(annotatable(article(false), { ...writable, ...locked }), false, JSON.stringify(locked));
  }
});

test('a reload or a switch to another conversation keeps each conversation draft separate', async () => {
  const storage = new Storage();
  const f = await opened({ storage });
  f.state.setQuote(quoteOf());
  f.state.addAnnotation(annotation({ comment: 'note' }));
  f.state.setInput('typed');
  await f.state.select('g:B');
  await flush();
  assert.equal(f.state.snapshot().input, '');
  assert.equal(f.state.snapshot().quote, null);
  f.state.setInput('other conversation');
  await f.state.select('g:A');
  await flush();
  assert.equal(f.state.snapshot().input, 'typed');
  f.state.destroy();
  const reloaded = await opened({ storage });
  const s = reloaded.state.snapshot();
  assert.equal(s.input, 'typed');
  assert.equal(s.quote.id, '12');
  assert.equal(s.annotations[0].comment, 'note');
  assert.equal(s.annotationSeq, 1);
  await reloaded.state.select('g:B');
  await flush();
  assert.equal(reloaded.state.snapshot().input, 'other conversation');
  reloaded.state.destroy();
});

test('a draft that cannot be stored is kept in memory and flagged', async () => {
  const storage = new Storage();
  const f = await opened({ storage });
  storage.failWrites = true;
  f.state.setInput('kept');
  assert.equal(f.state.snapshot().draftUnsaved, true);
  assert.equal(f.state.snapshot().input, 'kept');
  storage.failWrites = false;
  f.state.setInput('kept again');
  assert.equal(f.state.snapshot().draftUnsaved, false);
  f.state.destroy();
});

test('pinch zoom and Shift+wheel never quote; a plain sideways trackpad swipe does', async () => {
  const { createQuoteGesture, SWIPE_DISTANCE } = await import('../public/js/wb/chat-quote-gesture.js');
  const classes = () => { const set = new Set(); return { add: (...v) => v.forEach(x => set.add(x)), remove: (...v) => v.forEach(x => set.delete(x)), toggle: (x, on) => on ? set.add(x) : set.delete(x), contains: x => set.has(x) }; };
  const element = () => ({ classList: classes(), style: { setProperty() {}, removeProperty() {} }, children: [], setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
    getBoundingClientRect: () => ({ left: 0, right: 300 }) });
  const document = { createElement: element, defaultView: { getSelection: () => ({ isCollapsed: true }), getComputedStyle: () => ({ overflowX: 'visible' }) } };
  const article = { ...element(), dataset: { messageId: '7' }, isConnected: true, querySelector: () => null };
  const text = { ...element(), parentElement: article, closest: selector => selector.startsWith('article') ? article : null };
  article.children.push(text);
  const handlers = {}, timers = [], quoted = [];
  const list = { ownerDocument: document, contains: () => true, addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener() {} };
  createQuoteGesture({ list, document, onQuote: id => quoted.push(id), setTimeout: fn => timers.push(fn), clearTimeout() {} });
  const wheel = extra => { let prevented = false; handlers.wheel({ target: text, deltaX: SWIPE_DISTANCE + 4, deltaY: 0, deltaMode: 0, preventDefault: () => { prevented = true; }, ...extra }); return prevented; };
  assert.equal(wheel({ ctrlKey: true }), false);
  assert.equal(wheel({ shiftKey: true }), false);
  assert.equal(timers.length, 0);
  assert.deepEqual(quoted, []);
  assert.equal(wheel({ deltaX: -80 }), false, 'content moving right (fingers right, e.g. back) is left to the browser');
  assert.equal(wheel({}), true);
  timers.at(-1)();
  assert.deepEqual(quoted, ['7']);
});

test('a mouse drag and sideways-scrollable content never swipe; touch and pen do', async () => {
  const { createQuoteGesture } = await import('../public/js/wb/chat-quote-gesture.js');
  const classes = () => { const set = new Set(); return { add: (...v) => v.forEach(x => set.add(x)), remove: (...v) => v.forEach(x => set.delete(x)), toggle: (x, on) => on ? set.add(x) : set.delete(x), contains: x => set.has(x) }; };
  const element = () => ({ classList: classes(), style: { setProperty() {}, removeProperty() {} }, children: [], setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
    getBoundingClientRect: () => ({ left: 0, right: 300 }) });
  let overflowX = 'visible';
  const document = { createElement: element, defaultView: { getSelection: () => ({ isCollapsed: true }), getComputedStyle: () => ({ overflowX }) } };
  const article = { ...element(), dataset: { messageId: '9' }, isConnected: true, querySelector: () => null, setPointerCapture() {} };
  const text = { ...element(), parentElement: article, scrollWidth: 600, clientWidth: 300, closest: selector => selector.startsWith('article') ? article : null };
  article.children.push(text);
  const handlers = {}, quoted = [];
  const list = { ownerDocument: document, contains: () => true, addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener() {} };
  createQuoteGesture({ list, document, onQuote: id => quoted.push(id), setTimeout: () => 0, clearTimeout() {} });
  const drag = pointerType => {
    const base = { target: text, pointerType, pointerId: 1, isPrimary: true, clientY: 100 };
    handlers.pointerdown({ ...base, clientX: 250 });
    for (const clientX of [235, 210, 180, 160]) handlers.pointermove({ ...base, clientX });
    handlers.pointerup({ ...base, clientX: 160 });
  };
  drag('mouse');
  assert.deepEqual(quoted, [], 'a mouse drag selects text, it never quotes');
  overflowX = 'auto';
  drag('touch');
  assert.deepEqual(quoted, [], 'content that scrolls sideways keeps the swipe');
  overflowX = 'visible';
  drag('touch');
  drag('pen');
  assert.deepEqual(quoted, ['9', '9']);
});

test('the conversation page keeps the composer text read-only while a send outcome is open', async testContext => {
  const { createDocument, visibleNodes, tick } = await import('./helpers/conversation-dom.js');
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const document = createDocument(), root = document.createElement('div');
  document.defaultView = { innerWidth: 1280, innerHeight: 800, FormData, URL, matchMedia: () => ({ matches: false }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} };
  const sendAnswer = { stored: null, conversationId: 'g:AA', retryAllowed: true, needsReconciliation: true };
  let opened = { draft: false, stored: false, retryAllowed: true, preserveInput: false, conversation: { id: 'g:AA', state: 'active', displayName: 'Example' } };
  const fetch = async path => {
    // After the send, the conversation read reports the same open outcome until the test settles it.
    if (path.endsWith('/send')) opened = { ...opened, stored: null };
    const body = path.endsWith('/send') ? sendAnswer
      : path.endsWith('/uploads/config') ? { maxUploadBytes: 1024, maxAttachments: 1 }
      : path.includes('session-mode') ? { data: { sessionMode: 'multi' } }
      : path.includes('/messages') ? { items: [], nextCursor: null, afterCursor: 'after' }
      : path.includes('/status') || path.includes('/questions') ? { items: [], nextCursor: null }
      : /conversations\/[^/?]+$/.test(path) ? opened
      : { items: [{ id: 'g:AA', display_name: 'Example', draft: false }], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  };
  const page = mountConversationPage({ root, document, t: key => key, fetch, endpoint: path => path });
  testContext.after(() => page.destroy());
  await page.open();
  visibleNodes(root).find(node => node.dataset.conversationId)?.dispatch('click');
  await tick(); await tick();
  const input = visibleNodes(root).find(node => node.tagName === 'TEXTAREA' && node.classList.contains('conversation-input'));
  assert.equal(input.readOnly, false);
  input.value = 'words'; input.dispatch('input');
  root.querySelector('form.conversation-composer').dispatch('submit', { preventDefault() {} });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(input.readOnly, true, 'an open outcome locks the text for an identical retry');
  // A status read that finds the message not stored makes the text editable again.
  opened = { ...opened, stored: false };
  visibleNodes(root).find(node => node.dataset.action === 'refresh').dispatch('click');
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(input.readOnly, false);
  assert.equal(input.value, 'words');
});

test('a quote block whose original never loads says so, and a later successful jump clears that notice', async testContext => {
  const { createDocument, visibleNodes, visibleText, tick } = await import('./helpers/conversation-dom.js');
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const document = createDocument(), root = document.createElement('div');
  document.defaultView = { innerWidth: 1280, innerHeight: 800, FormData, URL, matchMedia: () => ({ matches: false }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} };
  const quote = id => ({ id, direction: 'out', timestamp: AT_1432, preview: 'original', available: true });
  const rows = [
    { id: 3, direction: 'out', status: 'delivered', timestamp: AT_1432, content: 'the original' },
    { id: 7, direction: 'in', status: 'delivered', timestamp: AT_1432, content: '[quote c4_id=3]\nabout this', quote: quote(3) },
    { id: 8, direction: 'in', status: 'delivered', timestamp: AT_1432, content: '[quote c4_id=2]\nabout that', quote: quote(2) },
  ];
  const fetch = async path => {
    const body = path.endsWith('/uploads/config') ? { maxUploadBytes: 1024, maxAttachments: 1 }
      : path.includes('session-mode') ? { data: { sessionMode: 'multi' } }
      : path.includes('/messages') ? { items: rows, nextCursor: null, afterCursor: 'after' }
      : path.includes('/status') || path.includes('/questions') ? { items: [], nextCursor: null }
      : /conversations\/[^/?]+$/.test(path) ? { draft: false, stored: false, conversation: { id: 'g:AA', state: 'active', displayName: 'Example' } }
      : { items: [{ id: 'g:AA', display_name: 'Example', draft: false }], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  };
  const page = mountConversationPage({ root, document, t: key => key, fetch, endpoint: path => path });
  testContext.after(() => page.destroy());
  await page.open();
  visibleNodes(root).find(node => node.dataset.conversationId)?.dispatch('click');
  for (let i = 0; i < 4; i++) await tick();
  const original = visibleNodes(root).find(node => node.tagName === 'ARTICLE' && node.dataset.messageId === '3');
  let shown = 0;
  original.scrollIntoView = () => { shown++; };
  const block = id => visibleNodes(root).find(node => node.dataset.action === 'quoteOpen' && node.dataset.quoteId === id);
  block('2').dispatch('click', { stopPropagation() {} });
  for (let i = 0; i < 4; i++) await tick();
  assert.match(visibleText(root), /chat\.quote\.missing/, 'every page is loaded and the original is not among them');
  block('3').dispatch('click', { stopPropagation() {} });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(shown, 1);
  assert.doesNotMatch(visibleText(root), /chat\.quote\.missing/);
});
