import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick, deferred } from './helpers/conversation-dom.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
import { createChatAttachment, chatAttachmentURL, attachmentDisplayText } from '../public/js/wb/chat-attachments.js';
import { buildAnnotatedContent, splitContentAndAttachments } from '../../comm-bridge/scripts/attachment-annotations.js';
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { renderChatContent } = await import('../public/js/wb/chat-blocks.js');
const { renderConversationContent } = await import('../public/js/wb/conversation-content.js');
const fixture = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/attachment-blocks.json', import.meta.url)));

// Pure native renderer/page-content imports with injected DOM, fetch and Blob URL adapters.
// No listener, database, timer loop, PM2 or tmux. Run for attachment authority,
// shared user/agent/tray rendering, lifecycle, load/download error or fallback changes.
// Every resource is destroyed by t.after even if an assertion fails.
const record = overrides => ({ id: 'opaque_attachment', name: 'photo.png', kind: 'image', size: 3, available: true, ...overrides });
function browser() {
  const document = createDocument(), create = document.createElement;
  const sources = [], clicked = [], revoked = [], objects = [];
  document.defaultView = { URL: {
    createObjectURL(blob) { objects.push(blob); return `blob:download-${objects.length}`; },
    revokeObjectURL(url) { revoked.push(url); },
  } };
  document.createElement = tag => {
    const node = create(tag);
    node.click = () => { clicked.push({ tag: node.tagName, href: node.href, download: node.download }); node.dispatch('click'); };
    node.removeAttribute = name => { delete node.attributes[name]; if (name === 'src') delete node.source; };
    if (tag === 'img') Object.defineProperty(node, 'src', { get: () => node.source, set(value) { node.source = value; sources.push(value); } });
    return node;
  };
  return { document, sources, clicked, revoked, objects };
}
function render(t, options = {}) {
  const env = browser(), changes = [];
  const context = { conversationId: 'g:A B', endpoint: path => '/dash/fleet/remote' + path,
    onLayout(change) { changes.push('before'); change(); changes.push('after'); }, ...options.context };
  const resource = createChatAttachment({ document: env.document, attachment: record(), t: key => key, ...options, context });
  t.after(() => resource.destroy());
  return { ...env, ...resource, changes };
}

test('attachment routes encode both identities and require available same-conversation metadata', () => {
  const context = { conversationId: 'g:A/ B', endpoint: path => '/dash/fleet/A%20B' + path };
  assert.equal(chatAttachmentURL(record({ id: 'opaque/ value' }), context), '/dash/fleet/A%20B/api/chat/conversations/g%3AA%2F%20B/attachments/opaque%2F%20value');
  for (const attachment of [record({ available: false }), record({ available: undefined }), record({ id: '' }), record({ external: true })]) assert.equal(chatAttachmentURL(attachment, context), null);
  assert.equal(chatAttachmentURL(record(), { ...context, external: true }), null);
  assert.equal(chatAttachmentURL(record(), {}), null);
  for (const unsafe of ['javascript:alert(1)', '//other.test/file', '/dash\\other/file', '/dash\nfile']) assert.equal(chatAttachmentURL(record(), { ...context, endpoint: () => unsafe }), null);
});

test('unavailable and external attachments show a name and explanation without browser resource requests', t => {
  for (const attachment of [record({ available: false }), record({ external: true }), { name: 'missing.pdf', kind: 'file', available: false }]) {
    const f = render(t, { attachment }); f.mount();
    assert.equal(f.node.querySelector('img,a,button'), null); assert.equal(f.sources.length, 0);
    assert.ok(f.node.textContent.includes(attachment.name));
    assert.match(f.node.textContent, attachment.external ? /chat.attachment.external/ : /chat.attachment.unavailable/);
  }
});

test('image reserves dimensions and retries only after a click while reporting layout transitions', t => {
  const f = render(t), img = f.node.querySelector('img'), frame = f.node.querySelector('.chat-attachment-image-frame');
  assert.equal(frame.style.aspectRatio, '4 / 3'); assert.equal(img.width, 640); assert.equal(img.height, 480);
  assert.equal(img.src, undefined); f.mount(); f.mount();
  assert.equal(f.sources.length, 1); assert.match(img.src, /^\/dash\/fleet\/remote\/api\/chat/);
  img.dispatch('error');
  assert.equal(img.hidden, true); assert.equal(frame.dataset.state, 'failed');
  const retry = f.node.querySelector('[data-action="retryAttachment"]'); assert.equal(retry.hidden, false);
  assert.match(f.node.textContent, /chat.attachment.loadFailed/); assert.equal(f.sources.length, 1);
  retry.dispatch('click'); assert.equal(f.sources.length, 2);
  img.dispatch('load'); assert.equal(frame.dataset.state, 'loaded'); assert.equal(img.hidden, false); assert.equal(retry.hidden, true);
  assert.deepEqual(f.changes, ['before', 'after', 'before', 'after', 'before', 'after', 'before', 'after']);
  f.destroy(); assert.equal(img.src, undefined); img.dispatch('error'); assert.equal(frame.dataset.state, 'loaded');
});

test('tray preview uses only caller-owned Blob URL and never an unlinked download route', t => {
  let removed = 0, retried = 0;
  const f = render(t, { attachment: record({ status: 'failed' }), mode: 'tray', localUrl: 'blob:local-file', onRemove() { removed++; }, onRetry() { retried++; } });
  f.mount(); assert.equal(f.sources[0], 'blob:local-file'); assert.equal(f.node.querySelector('[data-action="downloadAttachment"]'), null);
  f.node.querySelector('img').dispatch('load');
  assert.equal(f.node.querySelector('img').hidden, true);
  assert.equal(f.node.querySelector('.chat-attachment-image-frame').dataset.state, 'failed');
  assert.equal(f.node.querySelector('.chat-attachment-placeholder').hidden, false);
  assert.equal(f.node.dataset.attachmentState, 'failed'); assert.match(f.node.textContent, /chat.attachment.failed/);
  f.node.querySelector('[data-action="removeAttachment"]').dispatch('click'); f.node.querySelector('[data-action="retryUpload"]').dispatch('click');
  assert.equal(removed, 1); assert.equal(retried, 1);
  f.destroy(); assert.deepEqual(f.revoked, [], 'upload controller owns the local Blob URL');
  const untrusted = render(t, { mode: 'tray', localUrl: 'https://other.test/image' }); untrusted.mount(); assert.equal(untrusted.sources.length, 0);
});

test('tray progress is bounded and named for assistive technology', t => {
  const f = render(t, { mode: 'tray', attachment: record({ status: 'uploading', progress: 142 }) });
  const progress = f.node.querySelector('progress'); assert.equal(progress.value, 100); assert.equal(progress.max, 100);
  assert.equal(progress.getAttribute('aria-label'), 'chat.attachment.uploading');
});

test('tray updates preserve controls focus preview and progress nodes while changing transfer state', t => {
  let removed = 0, retried = 0;
  const f = render(t, { attachment: record({ status: 'uploading', progress: 8 }), mode: 'tray', localUrl: 'blob:local-file',
    onRemove() { removed++; }, onRetry() { retried++; } });
  f.mount();
  const remove = f.node.querySelector('[data-action="removeAttachment"]');
  const retry = f.node.querySelector('[data-action="retryUpload"]');
  const image = f.node.querySelector('img'), progress = f.node.querySelector('progress');
  remove.focus();
  f.update({ attachment: record({ status: 'uploading', progress: 42 }), localUrl: 'blob:local-file' });
  assert.equal(f.node.querySelector('[data-action="removeAttachment"]'), remove);
  assert.equal(f.node.querySelector('progress'), progress); assert.equal(progress.value, 42);
  assert.equal(f.document.activeElement, remove); assert.equal(f.node.querySelector('img'), image);
  assert.deepEqual(f.sources, ['blob:local-file'], 'progress must not reload the same preview');
  assert.match(f.node.textContent, /chat.attachment.uploading 42%/);
  assert.equal(retry.hidden, true);
  f.update({ attachment: record({ status: 'failed' }), disabled: true });
  assert.equal(retry.hidden, false); assert.equal(remove.disabled, true); assert.equal(retry.disabled, true);
  retry.dispatch('click'); assert.equal(retried, 0);
  f.update({ attachment: record({ status: 'expired' }), disabled: false });
  assert.equal(image.hidden, true); assert.equal(f.node.querySelector('.chat-attachment-placeholder').hidden, false);
  assert.equal(f.sources.length, 1);
  assert.equal(f.node.querySelector('[data-action="retryUpload"]'), retry);
  retry.dispatch('click'); remove.dispatch('click'); assert.equal(retried, 1); assert.equal(removed, 1);
  f.update({ attachment: record({ status: 'ready', name: 'normalized_name.png', size: 4096 }) });
  assert.equal(f.node.querySelector('.chat-attachment-name').textContent, 'normalized_name.png');
  assert.equal(f.node.querySelector('.chat-attachment-name').title, 'normalized_name.png');
  assert.match(f.node.querySelector('.chat-attachment-meta').textContent, /4.0 KB/);
  assert.equal(remove.getAttribute('aria-label'), 'chat.attachment.remove normalized_name.png');
  assert.equal(image.alt, 'normalized_name.png');
  assert.equal(image.hidden, false); assert.equal(f.sources.length, 1, 'ready preview reuses its original Blob source');
  assert.equal(progress.hidden, true); assert.equal(retry.hidden, true);
  assert.match(f.node.textContent, /chat.attachment.ready/);
  assert.equal(remove.classList.contains('wb-btn'), true); assert.equal(remove.classList.contains('action-btn'), false);
});

test('tray success metadata can change a local file to an image without replacing its controls', t => {
  const f = render(t, { attachment: record({ kind: 'file', name: 'a?.png', size: 3, status: 'uploading' }), mode: 'tray', onRemove() {} });
  const remove = f.node.querySelector('[data-action="removeAttachment"]'); remove.focus();
  f.update({ attachment: record({ kind: 'image', name: 'a_.png', size: 12, status: 'ready' }) });
  assert.equal(f.node.dataset.attachmentKind, 'image'); assert.equal(f.node.classList.contains('chat-attachment-image'), true);
  assert.ok(f.node.querySelector('.wb-ico-image')); assert.ok(f.node.querySelector('.chat-attachment-placeholder'));
  assert.equal(f.node.querySelector('.chat-attachment-name').textContent, 'a_.png');
  assert.equal(f.node.querySelector('[data-action="removeAttachment"]'), remove); assert.equal(f.document.activeElement, remove);
  assert.match(remove.getAttribute('aria-label'), /a_.png/);
  f.update({ attachment: record({ kind: 'file', status: 'ready' }) });
  assert.equal(f.node.dataset.attachmentKind, 'file'); assert.equal(f.node.querySelector('.chat-attachment-placeholder').hidden, true);
});

test('download refusal is visible and an explicit retry reads the same protected route once', async t => {
  let count = 0; const urls = [];
  const f = render(t, { attachment: record({ kind: 'file', name: 'report.pdf' }), context: { fetch: async url => {
    urls.push(url); count++; return count === 1 ? { ok: false, status: 403 } : { ok: true, blob: async () => new Blob(['abc']) };
  } } });
  const download = f.node.querySelector('[data-action="downloadAttachment"]');
  download.dispatch('click'); await tick();
  assert.match(f.node.textContent, /chat.attachment.downloadFailed/); assert.equal(download.disabled, false); assert.equal(count, 1);
  download.dispatch('click'); await tick();
  assert.equal(count, 2); assert.equal(urls[0], urls[1]);
  assert.equal(f.clicked.length, 1); assert.equal(f.clicked[0].download, 'report.pdf'); assert.equal(f.clicked[0].href, 'blob:download-1');
  f.destroy(); assert.deepEqual(f.revoked, ['blob:download-1']);
});

test('truncated and interrupted downloads never launch a successful save', async t => {
  for (const response of [{ ok: true, blob: async () => new Blob(['ab']) }, { ok: true, blob: async () => { throw new Error('connection closed'); } }]) {
    const f = render(t, { attachment: record({ kind: 'file' }), context: { fetch: async () => response } });
    f.node.querySelector('[data-action="downloadAttachment"]').dispatch('click'); await tick();
    assert.match(f.node.textContent, /chat.attachment.downloadFailed/); assert.equal(f.clicked.length, 0); assert.equal(f.objects.length, 0);
  }
});

test('disposing an in-flight download aborts and suppresses late UI and Blob URL creation', async t => {
  const gate = deferred(); let signal;
  const f = render(t, { context: { fetch: (url, options) => { signal = options.signal; return gate.promise; } } });
  f.node.querySelector('[data-action="downloadAttachment"]').dispatch('click'); f.destroy();
  assert.equal(signal.aborted, true);
  gate.resolve({ ok: true, blob: async () => new Blob(['abc']) }); await tick();
  assert.equal(f.clicked.length, 0); assert.equal(f.objects.length, 0);
});

test('transport annotations and external media paths stay out of plain text even without a renderer', () => {
  const annotation = '[attachment:image /private/media/secret.png name="photo.png" 3B]';
  assert.equal(attachmentDisplayText(`Full introduction\n${annotation}\nFull conclusion`), 'Full introduction\nFull conclusion');
  const document = createDocument();
  const root = renderChatContent({ document, row: { id: 12, content: `Visible body\n${annotation}`, attachments: [{ name: 'photo.png', kind: 'image', available: false }] } });
  assert.ok(root.textContent.includes('Visible body')); assert.ok(root.textContent.includes('photo.png')); assert.equal(root.textContent.includes('/private'), false);
  assert.equal(root.querySelector('img,a'), null);
  const media = renderChatContent({ document, external: true, row: { id: 13, content: '[MEDIA:image]/private/channel/photo.png', attachments: [] } });
  assert.equal(media.textContent, 'chat.attachment.externalMedia');
  assert.equal(attachmentDisplayText('[MEDIA:image]/private/local/photo.png'), '[MEDIA:image]/private/local/photo.png', 'own MEDIA remains ordinary text per design');
});

test('annotation suppression follows generated names and does not leak malformed transport references', () => {
  for (const name of ['quote"name.png', 'slash\\name.png', '你好.png', 'bracket]name.png']) {
    const raw = buildAnnotatedContent('Full body', [{ kind: 'image', path: '/private/media/original.png', name, size: 12 }]);
    assert.equal(splitContentAndAttachments(raw).attachments.length, 1);
    assert.equal(attachmentDisplayText(raw), 'Full body');
  }
  const escaped = 'Full body\n[attachment:file /private/media/document name="quote\\"name\\\\file.pdf" 12B]';
  assert.equal(attachmentDisplayText(escaped), 'Full body');
  for (const broken of ['[attachment:image /private/media/file name="broken" 12B', '[attachment:file /private/media/file name="quote"name" 12B]']) {
    assert.equal(attachmentDisplayText(broken), 'chat.attachment.unavailable');
  }
  const prose = 'Literal example [attachment:image placeholder] within a paragraph';
  assert.equal(attachmentDisplayText(prose), prose);
});

test('user and agent history share the same visual component and authorized endpoint', t => {
  const f = browser(), shared = record({ id: fixture.blocks[0].data.attachmentId, name: 'authoritative.png' });
  const context = { conversationId: 'g:A', endpoint: path => '/dash' + path };
  const source = { version: 1, kind: 'message', messageId: 'agent-message', fallbackText: 'fallback', blocks: [fixture.blocks[0]] };
  assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(source)).kind, 'envelope');
  const agent = renderConversationContent({ document: f.document, row: { id: 1, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(source), attachments: [shared] }, attachmentContext: context });
  const user = renderConversationContent({ document: f.document, row: { id: 2, direction: 'in', content: '[attachment:image /private/photo.png name="snapshot.png" 3B]', attachments: [shared] }, attachmentContext: context });
  t.after(() => { agent.destroy(); user.destroy(); }); agent.mount(); user.mount();
  assert.equal(agent.querySelector('.chat-attachment').className, user.querySelector('.chat-attachment').className);
  assert.equal(agent.querySelector('img').src, user.querySelector('img').src);
  assert.ok(agent.textContent.includes('authoritative.png')); assert.equal(agent.textContent.includes(shared.id), false); assert.equal(user.textContent.includes('/private'), false);
});

test('agent mixed message keeps markdown question chart and attachment order without new parsing rules', t => {
  const f = browser(); let questions = 0;
  const attachments = fixture.blocks.map((block, i) => record({ id: block.data.attachmentId, name: `latest-${i}`, kind: block.type === 'x-zylos.image' ? 'image' : 'file' }));
  const root = renderConversationContent({ document: f.document, row: { id: 42, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(fixture.mixed), attachments },
    attachmentContext: { conversationId: 'g:A' }, renderQuestion() { questions++; return f.document.createElement('fieldset'); } });
  t.after(() => root.destroy());
  const expected = fixture.mixed.blocks.map(block => block.id);
  assert.deepEqual(root.children.map(node => node.dataset.blockId), expected);
  assert.equal(root.querySelectorAll('.chat-attachment').length, 2); assert.equal(questions, 1);
  assert.equal(root.querySelector('fieldset').tagName, 'FIELDSET');
  for (const item of attachments) assert.ok(root.textContent.includes(item.name));
});

test('missing metadata never upgrades an agent snapshot to authority and capability fallback remains verbatim', t => {
  const f = browser(), source = { version: 1, kind: 'message', messageId: 'agent-message', fallbackText: 'fallback', blocks: [fixture.blocks[0]] };
  const row = { id: 1, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(source), attachments: [record({ id: 'different' })] };
  const unavailable = renderConversationContent({ document: f.document, row, attachmentContext: { conversationId: 'g:A' } });
  const unsupported = renderConversationContent({ document: f.document, row, attachmentContext: { conversationId: 'g:A' }, supportsBlock: () => false });
  t.after(() => { unavailable.destroy(); unsupported.destroy(); });
  assert.ok(unavailable.textContent.includes(fixture.blocks[0].data.nameSnapshot)); assert.match(unavailable.textContent, /chat.attachment.unavailable/);
  assert.equal(unavailable.querySelector('img,a,button'), null);
  assert.equal(unsupported.textContent, fixture.blocks[0].fallbackText); assert.equal(unsupported.querySelector('.chat-attachment'), null);
});

test('malformed attachment envelopes stay invalid and do not expose a partly guessed image', t => {
  const f = browser(), source = structuredClone(fixture.mixed); source.blocks[1].schemaVersion = 99;
  const root = renderConversationContent({ document: f.document, row: { id: 42, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(source), attachments: [record()] }, attachmentContext: { conversationId: 'g:A' } });
  t.after(() => root.destroy());
  assert.equal(root.textContent, 'chat.invalidContentchat.block.reference 42'); assert.equal(root.querySelector('img,a,button,fieldset'), null);
});

test('plain history metadata patches add replace and remove only owned media resources', t => {
  const f = browser(); let layouts = 0;
  const root = renderConversationContent({ document: f.document, row: { id: 1, direction: 'in', content: 'Visible body', attachments: [] },
    attachmentContext: { conversationId: 'g:A', onLayout(change) { layouts++; change(); } } });
  t.after(() => root.destroy()); root.mount();
  const body = root.querySelector('.chat-message-text');
  root.updateAttachments([record()]);
  const first = root.querySelector('.chat-attachment'), img = first.querySelector('img'); assert.ok(img.src);
  root.updateAttachments([record()]); assert.equal(root.querySelector('.chat-attachment'), first, 'unchanged metadata keeps the resource');
  root.updateAttachments([record({ name: 'updated.png' }), record({ id: 'second', kind: 'file', name: 'other.pdf' })]);
  assert.equal(img.src, undefined, 'replaced preview is disposed'); assert.equal(root.querySelectorAll('.chat-attachment').length, 2);
  root.updateAttachments([]); assert.equal(root.querySelector('.chat-attachment'), null);
  assert.equal(root.querySelector('.chat-message-text'), body); assert.equal(layouts >= 3, true);
  root.destroy(); root.updateAttachments([record()]); assert.equal(root.querySelector('.chat-attachment'), null);
});
