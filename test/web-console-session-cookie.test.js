import { describe, expect, test } from '@jest/globals';
import {
  appendSetCookie,
  cookiePathFromRequest,
  createSessionToken,
  isSecureRequest,
  readSessionTokens,
  resolveSessionTokens,
  sessionTokenPath,
} from '../skills/web-console/scripts/session-cookie.js';

const req = (headers) => ({ headers });

describe('cookiePathFromRequest', () => {
  test.each([
    [undefined, '/'],
    ['/console', '/console'],
    ['/console/', '/console'],
    ['/a/b_c-d', '/a/b_c-d'],
    ['/', '/'],
    ['  /console  ', '/console'],
    ['/console;Domain=x', '/'],
    ['/console\r\nSet-Cookie: x=1', '/'],
    ['/con sole', '/'],
    ['/a/../b', '/'],
    ['//evil', '/'],
    ['/a//b', '/'],
    ['console', '/'],
    ['/%2e%2e', '/'],
    [`/${'a'.repeat(63)}`, `/${'a'.repeat(63)}`],
    [`/${'a'.repeat(64)}`, '/'],
    [['/console', '/other'], '/'],
  ])('%j → %s', (prefix, expected) => {
    expect(cookiePathFromRequest(req(prefix === undefined ? {} : { 'x-forwarded-prefix': prefix }))).toBe(expected);
  });
});

describe('isSecureRequest', () => {
  test('https Origin or forwarded proto adds Secure; neither removes it', () => {
    expect(isSecureRequest(req({ origin: 'https://a.example' }))).toBe(true);
    expect(isSecureRequest(req({ 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isSecureRequest(req({ 'x-forwarded-proto': 'HTTPS, http' }))).toBe(true);
    expect(isSecureRequest(req({ origin: 'https://a.example', 'x-forwarded-proto': 'http' }))).toBe(true);
    expect(isSecureRequest(req({ 'x-forwarded-proto': 'http' }))).toBe(false);
    expect(isSecureRequest(req({}))).toBe(false);
  });
});

describe('session tokens', () => {
  test('tokens record the path they were issued for; bare tokens mean /', () => {
    const scoped = createSessionToken('/console');
    expect(scoped).toMatch(/^[0-9a-f]{64}:\/console$/);
    expect(sessionTokenPath(scoped)).toBe('/console');
    const root = createSessionToken('/');
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionTokenPath(root)).toBe('/');
    expect(sessionTokenPath('abc:not a path')).toBeNull();
  });

  test('readSessionTokens returns every wc_session value in order', () => {
    expect(readSessionTokens('a=1; wc_session=x:/console; wc_session=y; b=2')).toEqual(['x:/console', 'y']);
    expect(readSessionTokens('')).toEqual([]);
    expect(readSessionTokens('wc_session=')).toEqual([]);
  });

  test('resolveSessionTokens keeps the first valid same-path token and retires other paths', () => {
    const valid = new Set(['a:/console', 'b:/console']);
    const result = resolveSessionTokens(['old', 'x:/console', 'a:/console', 'b:/console', 'c:bad path'], '/console', (t) => valid.has(t));
    expect(result.token).toBe('a:/console');
    expect(result.retire).toEqual([{ token: 'old', path: '/' }, { token: 'c:bad path', path: null }]);
  });

  test('appendSetCookie keeps cookies already on the response', () => {
    const headers = {};
    const res = { getHeader: (n) => headers[n], setHeader: (n, v) => { headers[n] = v; } };
    appendSetCookie(res, ['a=1']);
    appendSetCookie(res, ['b=2', 'c=3']);
    expect(headers['Set-Cookie']).toEqual(['a=1', 'b=2', 'c=3']);
  });
});
