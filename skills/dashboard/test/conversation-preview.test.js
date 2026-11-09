import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPreview } from '../src/lib/chat/history.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
// Pure text/schema path only. No history database or network is opened.
const packet = text => CONTENT_PREFIX + JSON.stringify({version:1,kind:'message',messageId:'readable-preview',fallbackText:text,blocks:[{id:'body',type:'markdown',schemaVersion:1,fallbackText:text,data:{text:'body'}}]});
test('structured list preview includes only human fallback, without model references',()=>{assert.equal(conversationPreview(packet('Short answer')),'Short answer');});
test('invalid content yields only a generic readable notice',()=>{assert.equal(conversationPreview(CONTENT_PREFIX+'{broken'),'无法显示的消息');assert.ok(!conversationPreview(CONTENT_PREFIX+'{broken').includes('c4_id'));});
test('plain text containing marker-like text remains literal user text',()=>{const text='Literal [C4 messageId=example; c4_id=7]';assert.equal(conversationPreview(text),text);});
test('preview truncation preserves complete Unicode characters',()=>{assert.equal(conversationPreview('😀'.repeat(161)),'😀'.repeat(160));assert.equal(conversationPreview(packet('🪴'.repeat(161))),'🪴'.repeat(160));});

test('incremental and list summaries retain mixed text and attachment names without managed paths', async () => {
  const { buildAttachmentAnnotation } = await import('../../comm-bridge/scripts/attachment-annotations.js');
  const annotation = buildAttachmentAnnotation({ path: '/private/managed/report.pdf', name: 'report.pdf', size: 12, kind: 'file' });
  assert.equal(conversationPreview('Readable text\n' + annotation), 'Readable text\n[文件] report.pdf');
  assert.equal(conversationPreview('[MEDIA:image]/private/source.png\n' + annotation, { external: true }), '[媒体] 原渠道附件\n[文件] report.pdf');
});


test('conversation previews remove each Markdown marker while preserving human text', () => {
  const examples = [
    ['**没跑的原因**：昨天', '没跑的原因：昨天'],
    ['__bold__ and *italic* and _斜体_', 'bold and italic and 斜体'],
    ['Use `foo_bar()` 调用', 'Use foo_bar() 调用'],
    ['[文档 **docs**](https://example.com/a_(b))', '文档 docs'],
    ['## 标题 Title', '标题 Title'],
    ['- 第一项\n* Second item\n1. 第三项', '第一项\nSecond item\n第三项'],
    ['> 引用 **mixed**\n> next line', '引用 mixed\nnext line'],
    ['***加粗且斜体*** and snake_case', '加粗且斜体 and snake_case'],
    ['[说明][ref]\n\n[ref]: https://example.com', '说明'],
    ['# Heading\nBody follows', 'Heading\nBody follows'],
    ['First  \nSecond', 'First\nSecond'],
    ['<b>literal HTML</b> &amp; text', '<b>literal HTML</b> & text'],
    ['![**diagram** label](https://example.com/image.png)', 'diagram label'],
    ['| Name | Value |\n| --- | --- |\n| A | B |', 'Name Value \nA B'],
  ];
  for (const [source, expected] of examples) assert.equal(conversationPreview(source), expected, source);
});

test('plain and structured previews use the shared CJK-friendly parser', () => {
  const source = '**（粗体）**后文 `**（代码）**后文` **Bold** and *italic*';
  const expected = '（粗体）后文 **（代码）**后文 Bold and italic';
  assert.equal(conversationPreview(source), expected);
  assert.equal(conversationPreview(packet(source)), expected);
  assert.equal(conversationPreview(packet(source), { locale: 'en' }), expected);
  assert.equal(conversationPreview(packet('前文__【粗体】__后文')), '前文__【粗体】__后文');
});

test('markup-only content falls back to the original text before the Unicode limit', () => {
  for (const content of ['-', '---', '***', '___', '---\n'.repeat(80)]) {
    assert.equal(conversationPreview(content), Array.from(content).slice(0, 160).join(''));
  }
});

test('attachment names and placeholders stay outside Markdown parsing', async () => {
  const { buildAttachmentAnnotation } = await import('../../comm-bridge/scripts/attachment-annotations.js');
  for (const [kind, name, label] of [['file', '__init__.py', '[File]'], ['image', '~~draft~~.png', '[Image]']]) {
    const annotation = buildAttachmentAnnotation({ path: '/private/managed/' + name, name, size: 12, kind });
    assert.equal(conversationPreview('**Body**\n' + annotation, { locale: 'en' }), `Body\n${label} ${name}`);
    assert.equal(conversationPreview('```js\nunclosed\n' + annotation, { locale: 'en' }), `[Code]\n${label} ${name}`);
    const envelope = { version: 1, kind: 'message', messageId: 'named-attachment', fallbackText: 'unused', blocks: [
      { id: 'body', type: 'markdown', schemaVersion: 1, fallbackText: '```js\nunclosed', data: { text: '```js\nunclosed' } },
      { id: 'asset', type: 'x-zylos.' + kind, schemaVersion: 1, data: { attachmentId: 'private-id', nameSnapshot: name }, fallbackText: 'unused' }
    ] };
    assert.equal(conversationPreview(CONTENT_PREFIX + JSON.stringify(envelope), { locale: 'en' }), `[Code]\n${label} ${name}`);
  }
});

test('external media labels use the current language outside code fences', () => {
  const content = '```js\nunclosed\n[MEDIA:image]/private/source.png';
  assert.equal(conversationPreview(content, { external: true, locale: 'en' }), '[Code]\n[Media] Original-channel attachment');
  assert.equal(conversationPreview('[MEDIA:image]/private/source.png', { external: true }), '[媒体] 原渠道附件');
});

test('code blocks use localized short placeholders without exposing their body', () => {
  for (const source of ['```js\nconst secret = 1;\n```', '~~~python\nprint(1)\n~~~', '    code body']) {
    assert.equal(conversationPreview(source), '[代码]');
    assert.equal(conversationPreview(source, { locale: 'en' }), '[Code]');
  }
  assert.equal(conversationPreview('Before\n\n```text\nbody\n```\nAfter', { locale: 'en' }), 'Before\n[Code]\nAfter');
});

test('structured charts and controls use localized placeholders in mixed messages', async () => {
  const fs = await import('node:fs');
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
  for (const kind of ['time_series', 'breakdown', 'category_series', 'single', 'form']) {
    const envelope = structuredClone(fixtures.valid.find(item => item.name === kind).envelope);
    const expected = ['time_series', 'breakdown', 'category_series'].includes(kind) ? ['[图表]', '[Chart]'] : ['[组件]', '[Component]'];
    assert.equal(conversationPreview(CONTENT_PREFIX + JSON.stringify(envelope)), expected[0], kind);
    assert.equal(conversationPreview(CONTENT_PREFIX + JSON.stringify(envelope), { locale: 'en' }), expected[1], kind);
    envelope.blocks.unshift({ id: 'intro', type: 'markdown', schemaVersion: 1, fallbackText: '**结果 Result**', data: { text: '**结果 Result**' } });
    assert.equal(conversationPreview(CONTENT_PREFIX + JSON.stringify(envelope)), '结果 Result\n' + expected[0]);
    envelope.blocks[0].fallbackText = '```js\nunclosed';
    assert.equal(conversationPreview(CONTENT_PREFIX + JSON.stringify(envelope), { locale: 'en' }), '[Code]\n' + expected[1]);
  }
});

test('the existing Unicode limit applies after Markdown removal at and beyond its boundary', () => {
  const text = '中A😀'.repeat(53) + '末';
  assert.equal(Array.from(text).length, 160);
  assert.equal(conversationPreview('**' + text + '**'), text);
  assert.equal(conversationPreview('**' + text + 'X**'), text);
  assert.equal(conversationPreview('[**' + text + '**](https://example.com)'), text);
  assert.equal(conversationPreview(packet('## **' + text + '**')), text);
});
