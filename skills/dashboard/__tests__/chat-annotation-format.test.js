import { registerHooks } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { composeContent, parseSentAnnotations } = await import('../public/js/wb/chat-compose-text.js');

// The annotation message is a text format shared by the web and App composers and read back by both message views:
// whatever either language pack composes must read back whole, and anything else must stay plain text.
test('annotation messages composed in either language read back as their items', () => {
  const annotations = [
    { messageId: 12, direction: 'out', timestamp: '2026-11-22T00:11:00Z', excerpt: 'Line one\nline two', length: 17, comment: 'ok\nnext' },
    { messageId: 34, direction: 'in', timestamp: '2026-11-22T00:12:00Z', excerpt: 'x'.repeat(4001), length: 5000, comment: '' },
  ];
  for (const lang of ['en', 'zh']) {
    const pack = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${lang}.json`, import.meta.url), 'utf8'));
    const t = (key, params = {}) => Object.entries(params).reduce((value, [name, param]) => value.replaceAll(`{${name}}`, param), pack[key] ?? key);
    const compose = text => composeContent({ text, annotations, timeZone: 'Asia/Singapore', t });
    const read = parseSentAnnotations(compose(''));
    assert.equal(read.text, null, lang);
    assert.deepEqual(read.items.map(item => [item.author, item.messageId, item.excerpt.length, item.comment]),
      [['AI', '12', 17, 'ok\nnext'], [t('chat.annotation.sendMe'), '34', 4000, '']], lang);
    assert.equal(read.items[0].excerpt, 'Line one\nline two', lang);
    assert.equal(parseSentAnnotations(compose('Mine\nwords')).text, 'Mine\nwords', lang);
    assert.equal(parseSentAnnotations(compose('').replace('c4_id=34', 'c4_id=x')), null, lang);
  }
  assert.equal(parseSentAnnotations('plain text'), null);
});
