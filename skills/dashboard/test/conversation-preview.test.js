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
  const { buildAttachmentAnnotation } = await import('../../web-console/scripts/attachment-utils.js');
  const annotation = buildAttachmentAnnotation({ path: '/private/managed/report.pdf', name: 'report.pdf', size: 12, kind: 'file' });
  assert.equal(conversationPreview('Readable text\n' + annotation), 'Readable text\n[文件] report.pdf');
  assert.equal(conversationPreview('[MEDIA:image]/private/source.png\n' + annotation, { external: true }), '[媒体] 原渠道附件\n[文件] report.pdf');
});
