import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRouteBlocks } from '../cli/lib/caddy.js';

describe('generateRouteBlocks', () => {
  test('adds X-Forwarded-Prefix for stripped reverse proxy routes', () => {
    const block = generateRouteBlocks([{
      path: '/recruit/*',
      type: 'reverse_proxy',
      target: 'localhost:3465',
      strip_prefix: '/recruit',
    }]);

    assert.ok(block.includes('    redir /recruit /recruit/ permanent'));
    assert.ok(block.includes('        uri strip_prefix /recruit'));
    assert.ok(block.includes('        reverse_proxy localhost:3465 {'));
    assert.ok(block.includes('            header_up X-Forwarded-Prefix /recruit'));
  });

});
