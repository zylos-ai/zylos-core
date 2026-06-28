import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatSection } from '../session-format.js';

describe('formatSection', () => {
  it('wraps content with matching header and footer', () => {
    assert.equal(
      formatSection('BOT IDENTITY', 'I am Zylos'),
      '=== BOT IDENTITY ===\nI am Zylos\n=== END BOT IDENTITY ===',
    );
  });

  it('trims surrounding whitespace in the body', () => {
    assert.equal(
      formatSection('X', '\n  hello \n\n'),
      '=== X ===\nhello\n=== END X ===',
    );
  });

  it('renders (empty) for empty, whitespace-only, or nullish content', () => {
    for (const value of ['', '   \n ', null, undefined]) {
      assert.equal(formatSection('X', value), '=== X ===\n(empty)\n=== END X ===');
    }
  });

  it('preserves multi-line bodies between the header and footer', () => {
    const out = formatSection('RECENT CONVERSATIONS', 'line1\nline2\nline3');
    assert.equal(out, '=== RECENT CONVERSATIONS ===\nline1\nline2\nline3\n=== END RECENT CONVERSATIONS ===');
  });
});
