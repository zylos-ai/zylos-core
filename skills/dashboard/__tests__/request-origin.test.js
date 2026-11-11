import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from '../src/lib/request-origin.js';

const request = (headers = {}) => ({ headers: { origin: 'https://example.test', host: 'example.test', ...headers } });

test('same-origin Fetch Metadata accepts the public HTTPS request despite proxy protocol or Host rewriting', () => {
  for (const host of ['example.test', 'internal:3000', undefined]) {
    assert.equal(isSameOriginRequest(request({ 'sec-fetch-site': ' Same-Origin ', 'x-forwarded-proto': 'http', host })), true);
  }
  assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true);
});

for (const [name, value] of [
  ['same-site', 'same-site'], ['cross-site', 'cross-site'], ['none', 'none'],
  ['empty', ''], ['whitespace', ' \t '], ['undefined', undefined], ['null', null],
  ['number', 1], ['object', { toString: () => 'same-origin' }],
  ['single-value array', ['same-origin']], ['multiple-value array', ['same-origin', 'cross-site']],
  ['combined tokens', 'same-origin, cross-site'], ['repeated token', 'same-origin, same-origin'],
  ['unknown token', 'future-value'], ['token with parameter', 'same-origin;foo=1'],
]) {
  test(`present Fetch Metadata rejects ${name} without falling back to matching Origin/Host`, () => {
    assert.equal(isSameOriginRequest(request({ 'sec-fetch-site': value })), false);
  });
}

test('absent Fetch Metadata falls back independently of forwarding protocol and socket encryption', () => {
  for (const forwarded of [undefined, 'http', 'https', 'garbage']) {
    for (const encrypted of [false, true]) {
      assert.equal(isSameOriginRequest({ ...request({ 'x-forwarded-proto': forwarded }), socket: { encrypted } }), true);
    }
  }
  const req = request();
  Object.defineProperty(req.headers, 'x-forwarded-proto', { get() { throw new Error('must not read forwarded protocol'); } });
  Object.defineProperty(req, 'socket', { get() { throw new Error('must not infer transport protocol'); } });
  assert.equal(isSameOriginRequest(req), true);
});

for (const [origin, host, expected] of [
  ['https://example.test', 'example.test:443', true],
  ['http://example.test', 'example.test:80', true],
  ['https://example.test:80', 'example.test', false],
  ['https://example.test:80', 'example.test:443', false],
  ['http://example.test:443', 'example.test', false],
  ['http://example.test:443', 'example.test:80', false],
  ['https://example.test', 'example.test:80', false],
  ['https://example.test:80', 'example.test:80', true],
  ['http://example.test:443', 'example.test:443', true],
  ['https://example.test:8443', 'example.test:8443', true],
  ['https://example.test:8443', 'example.test:8444', false],
  ['https://example.test', 'sibling.example.test', false],
  ['https://example.test', 'evil.test', false],
  ['https://[::1]', '[::1]:443', true],
  ['http://[::1]', '[::1]:80', true],
  ['https://[::1]:80', '[::1]', false],
  ['https://[::1]:8443', '[::1]:8443', true],
  ['https://[::1]', '[::2]', false],
  ['https://[2001:db8::1]', '[2001:0DB8:0:0:0:0:0:1]:443', true],
]) {
  test(`fallback ${origin} against Host ${host} is ${expected}`, () => {
    assert.equal(isSameOriginRequest(request({ origin, host })), expected);
  });
}

test('Host preserves existing first-value normalization', () => {
  for (const host of [' EXAMPLE.TEST:443 ', 'EXAMPLE.TEST:443, internal:3000', ['EXAMPLE.TEST:443', 'internal:3000']]) {
    assert.equal(isSameOriginRequest(request({ host })), true);
  }
});

test('fallback rejects missing, malformed and noncanonical Origin values', () => {
  for (const origin of [undefined, null, '', 'null', [], ['https://example.test'], 1, {},
    'https://example.test/', 'https://example.test/path', 'https://example.test?x=1',
    'https://example.test#fragment', 'https://user@example.test', 'https://EXAMPLE.TEST',
    'https://example.test:443', ' https://example.test', 'https://example.test\n',
    'https:example.test', '//example.test', 'not a URL', 'ftp://example.test',
    'wss://example.test', 'file://example.test', 'https://example.test, https://evil.test']) {
    assert.equal(isSameOriginRequest(request({ origin })), false, `Origin: ${JSON.stringify(origin)}`);
  }
});

test('fallback rejects missing, malformed or URL-confusing Host authorities', () => {
  for (const host of [undefined, null, '', ' ', [], [undefined], [{}], 1, {},
    'evil@example.test', 'example.test/x', 'example.test\\x', 'example.test#x',
    'example.test?x', 'example.test\nx', 'example.test\tx', 'example.test%2f',
    'https://example.test', 'example.test:', 'example.test:abc', 'example.test:65536',
    '[::1', '::1', '[not-ipv6]', 'example.test:443:80', ', example.test']) {
    assert.equal(isSameOriginRequest(request({ host })), false, `Host: ${JSON.stringify(host)}`);
  }
  assert.equal(isSameOriginRequest({}), false);
});
