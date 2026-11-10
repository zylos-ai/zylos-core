import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionCookiePath, isLocalHttpsProxy, appendSetCookie, setSessionCookie, clearSessionCookie
} from '../session-cookie.js';

function request(...values) {
  const [prefix, proto, address] = ['/console', 'https', '127.0.0.1']
    .map((fallback, index) => index < values.length ? values[index] : fallback);
  return { headers: { 'x-forwarded-prefix': prefix, 'x-forwarded-proto': proto },
    socket: { remoteAddress: address } };
}

function response(existing) {
  let cookies = existing;
  return { getHeader: () => cookies, setHeader: (_name, value) => { cookies = value; } };
}

test('cookie prefix accepts only complete safe strings up to 64 characters', () => {
  for (const prefix of ['/', '/console', '/Console_2/a-b/', `/${'a'.repeat(63)}`]) {
    assert.equal(sessionCookiePath(prefix), prefix);
  }
  for (const prefix of [undefined, null, [], ['/console'], '/console,/pages', '/console, /pages',
    '', 'console', '//console', '/a//b', '/..', '/a/../b', '/console;', '/console?x',
    '/console#x', '/console%2f', '/console\\x', '/console\r\n', '/console\n', '/console\t', '/console ', ' /console',
    '/con sole', '/café', `/${'a'.repeat(64)}`]) {
    assert.equal(sessionCookiePath(prefix), '/', JSON.stringify(prefix));
  }
});

test('Secure requires both a loopback peer and one exact https forwarding value', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocalHttpsProxy(request('/console', 'https', address)), true);
  }
  for (const address of ['192.0.2.1', '::ffff:192.0.2.1', '127.evil', '', undefined]) {
    assert.equal(isLocalHttpsProxy(request('/console', 'https', address)), false);
  }
  for (const proto of [undefined, 'http', 'HTTPS', 'https,http', 'https, http', ['https'], ' https']) {
    assert.equal(isLocalHttpsProxy(request('/console', proto)), false);
  }
});

test('appending cookies preserves an existing string and existing array', () => {
  for (const existing of ['other=one', ['other=one', 'another=two']]) {
    const res = response(existing);
    appendSetCookie(res, 'new=three');
    assert.deepEqual(res.getHeader(), [...(Array.isArray(existing) ? existing : [existing]), 'new=three']);
  }
});

test('scoped login expires the legacy root before setting the remembered scoped token', () => {
  const res = response('other=one');
  setSessionCookie(request(), res, 'token', { maxAgeSec: 604800 });
  assert.deepEqual(res.getHeader(), ['other=one',
    'wc_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0',
    'wc_session=token; Path=/console; HttpOnly; SameSite=Strict; Secure; Max-Age=604800']);
});

test('remember false creates a session cookie without changing the cleanup cookie', () => {
  const res = response();
  setSessionCookie(request('/console', 'http'), res, 'token', { remember: false, maxAgeSec: 604800 });
  assert.deepEqual(res.getHeader(), ['wc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    'wc_session=token; Path=/console; HttpOnly; SameSite=Strict']);
});

test('remember values other than false retain the existing persistent-cookie behavior', () => {
  for (const remember of [undefined, true, null, 0, 'false']) {
    const res = response();
    setSessionCookie(request('/console', 'http'), res, 'token', { remember, maxAgeSec: 604800 });
    assert.ok(res.getHeader().at(-1).endsWith('; Max-Age=604800'));
  }
});

test('root fallback emits one usable cookie and never expires its newly set token', () => {
  for (const prefix of [undefined, '/', '/console,/pages']) {
    const res = response();
    setSessionCookie(request(prefix, 'http'), res, 'token', { remember: true, maxAgeSec: 604800 });
    assert.deepEqual(res.getHeader(), ['wc_session=token; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800']);
  }
});

test('logout uses the same validated path and retains unrelated cookies', () => {
  for (const [prefix, expected] of [['/console', '/console'], ['/a/b', '/a/b'], ['/bad;', '/']]) {
    const res = response(['other=one']);
    clearSessionCookie(request(prefix), res);
    assert.deepEqual(res.getHeader(), ['other=one',
      `wc_session=; Path=${expected}; HttpOnly; SameSite=Strict; Secure; Max-Age=0`]);
  }
});
