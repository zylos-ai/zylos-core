import assert from 'node:assert/strict';
import test from 'node:test';
import { isPathWithinBase } from '../src/lib/browser-base.js';

test('paths outside the browser base are rejected', () => {
  const outside = [
    'https://evil.test/dashboard/',
    'javascript:alert(1)',
    '//evil.test',
    '//evil.test/dashboard/',
    '/\\evil.test',
    '/\\evil.test/dashboard/',
    '/dashboard\\..\\admin',
    '/dashboard/../admin',
    '/dashboard/%2e%2e/admin',
    '/admin',
    '/dashboardx',
    '/dashboardx/y',
    '/dashboard/\nmemory',
    '',
    null
  ];
  for (const path of outside) assert.equal(isPathWithinBase(path, '/dashboard'), false, JSON.stringify(path));
});

test('paths at or under the browser base are accepted', () => {
  for (const path of ['/dashboard', '/dashboard/', '/dashboard/memory', '/dashboard/memory?tab=files#top']) {
    assert.equal(isPathWithinBase(path, '/dashboard'), true, path);
  }
});

test('without a base, any same-origin absolute path is accepted and other origins are not', () => {
  for (const path of ['/', '/memory', '/admin']) assert.equal(isPathWithinBase(path, ''), true, path);
  for (const path of ['//evil.test', '/\\evil.test', 'https://evil.test/', 'javascript:alert(1)']) {
    assert.equal(isPathWithinBase(path, ''), false, path);
  }
});
