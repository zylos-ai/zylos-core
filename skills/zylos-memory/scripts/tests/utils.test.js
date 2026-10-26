import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findHeaderDate } from '../rotate-session.js';
import { parseSessionDate } from '../consolidate.js';
import { formatBytes } from '../memory-status.js';

// ---------------------------------------------------------------------------
// findHeaderDate  (rotate-session.js)
// ---------------------------------------------------------------------------
describe('findHeaderDate', () => {
  it('extracts date from valid session header', () => {
    const text = '# Session Log: 2025-06-15\n\nSome content here.';
    assert.equal(findHeaderDate(text), '2025-06-15');
  });

  it('extracts date when header is not on first line', () => {
    const text = 'Some preamble\n# Session Log: 2025-01-01\nContent';
    assert.equal(findHeaderDate(text), '2025-01-01');
  });

  it('returns null for missing header', () => {
    const text = 'No header here\nJust some text.';
    assert.equal(findHeaderDate(text), null);
  });

  it('returns null for empty string', () => {
    assert.equal(findHeaderDate(''), null);
  });

  it('returns null for malformed header (wrong format)', () => {
    const text = '# Session Log: 06-15-2025\n';
    assert.equal(findHeaderDate(text), null);
  });

  it('returns null for header with extra text after date', () => {
    const text = '# Session Log: 2025-06-15 extra\n';
    assert.equal(findHeaderDate(text), null);
  });

  it('handles header with trailing whitespace', () => {
    const text = '# Session Log: 2025-06-15   \n';
    assert.equal(findHeaderDate(text), '2025-06-15');
  });

  it('returns first match when multiple headers exist', () => {
    const text = '# Session Log: 2025-01-01\n# Session Log: 2025-02-02\n';
    assert.equal(findHeaderDate(text), '2025-01-01');
  });

  it('returns null for header missing the colon', () => {
    const text = '# Session Log 2025-06-15\n';
    assert.equal(findHeaderDate(text), null);
  });
});

// ---------------------------------------------------------------------------
// parseSessionDate  (consolidate.js)
// ---------------------------------------------------------------------------
describe('parseSessionDate', () => {
  it('parses simple date filename', () => {
    assert.equal(parseSessionDate('2025-06-15.md'), '2025-06-15');
  });

  it('parses date filename with collision suffix', () => {
    assert.equal(parseSessionDate('2025-06-15-1.md'), '2025-06-15');
  });

  it('parses date filename with larger collision suffix', () => {
    assert.equal(parseSessionDate('2025-06-15-42.md'), '2025-06-15');
  });

  it('returns null for current.md', () => {
    assert.equal(parseSessionDate('current.md'), null);
  });

  it('returns null for non-matching filename', () => {
    assert.equal(parseSessionDate('notes.md'), null);
  });

  it('returns null for filename without .md extension', () => {
    assert.equal(parseSessionDate('2025-06-15.txt'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseSessionDate(''), null);
  });

  it('returns null for date-like string without .md', () => {
    assert.equal(parseSessionDate('2025-06-15'), null);
  });

  it('returns null for partial date', () => {
    assert.equal(parseSessionDate('2025-06.md'), null);
  });
});

// ---------------------------------------------------------------------------
// formatBytes  (memory-status.js)
// ---------------------------------------------------------------------------
describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    assert.equal(formatBytes(0), '0B');
  });

  it('formats bytes less than 1024', () => {
    assert.equal(formatBytes(512), '512B');
  });

  it('formats exactly 1023 bytes', () => {
    assert.equal(formatBytes(1023), '1023B');
  });

  it('formats exactly 1024 bytes as KB', () => {
    assert.equal(formatBytes(1024), '1.0KB');
  });

  it('formats bytes above 1024', () => {
    assert.equal(formatBytes(2048), '2.0KB');
  });

  it('formats fractional KB', () => {
    assert.equal(formatBytes(1536), '1.5KB');
  });

  it('formats large values in KB', () => {
    assert.equal(formatBytes(10240), '10.0KB');
  });

  it('formats 1 byte', () => {
    assert.equal(formatBytes(1), '1B');
  });
});
