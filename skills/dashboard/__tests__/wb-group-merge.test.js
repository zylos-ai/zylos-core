import test from 'node:test';
import assert from 'node:assert/strict';
import { redactQuerySecrets, safePreview } from '../src/lib/workbench/group-merge.js';

test('the preview drops credential values from links but keeps the link readable', () => {
  const said = { preview: { message: 'open https://x.test/a?token=abc123&page=2 and https://y.test/b?id=1&api_key=K-9.z#top', timestamp: 1, channel: 'lark' } };
  assert.equal(safePreview(said).text, 'open https://x.test/a?token=[REDACTED]&page=2 and https://y.test/b?id=1&api_key=[REDACTED]#top');
  assert.equal(redactQuerySecrets('?access_token=t1&Signature=s2&X-Auth=a3&PASSWORD=p4'), '?access_token=[REDACTED]&Signature=[REDACTED]&X-Auth=[REDACTED]&PASSWORD=[REDACTED]');
  // The value ends at whitespace, "&", "#" or the first non-ASCII character: the words after the link stay.
  assert.equal(redactQuerySecrets('用?token=abc来连接'), '用?token=[REDACTED]来连接');
  assert.equal(redactQuerySecrets('https://x.test/?key=a1 then more'), 'https://x.test/?key=[REDACTED] then more');
  // Names are matched as whole words: these are not credentials.
  assert.equal(redactQuerySecrets('https://x.test/?monkey=1&hotkey=2&keyboard=us&tokens2=3'), 'https://x.test/?monkey=1&hotkey=2&keyboard=us&tokens2=3');
  // camelCase names split at the case change, and an HTML-escaped "&amp;" separates parameters like "&".
  assert.equal(redactQuerySecrets('https://x.test/?accessToken=a1&authToken=b2&clientSecret=c3&APIKey=d4'), 'https://x.test/?accessToken=[REDACTED]&authToken=[REDACTED]&clientSecret=[REDACTED]&APIKey=[REDACTED]');
  assert.equal(redactQuerySecrets('<a href="https://x.test/?page=2&amp;token=abc&amp;id=7">'), '<a href="https://x.test/?page=2&amp;token=[REDACTED]&amp;id=7">');
  assert.equal(redactQuerySecrets('https://x.test/?monkeyKing=1&hotKeys=2&tokenizer=3'), 'https://x.test/?monkeyKing=1&hotKeys=2&tokenizer=3', 'no credential word: kept');
  // A link nested in another parameter's value loses its credential too; the outer value stays readable.
  assert.equal(redactQuerySecrets('https://x.test/login?redirect=https://y/?token=abc'), 'https://x.test/login?redirect=https://y/?token=[REDACTED]');
  assert.equal(redactQuerySecrets('?next=/cb?access_token=abc&page=2'), '?next=/cb?access_token=[REDACTED]&page=2');
  assert.equal(redactQuerySecrets('?a=b?token=abc'), '?a=b?token=[REDACTED]');
  assert.equal(redactQuerySecrets('?next=/cb?monkey=1'), '?next=/cb?monkey=1', 'nested, no credential word: kept');
  // Only a URL query parameter counts: "token=" written in a sentence, or after another separator, stays.
  assert.equal(redactQuerySecrets('the token=abc field and monkey business'), 'the token=abc field and monkey business');
  assert.equal(redactQuerySecrets('a;token=abc and (key=abc)'), 'a;token=abc and (key=abc)');
});
