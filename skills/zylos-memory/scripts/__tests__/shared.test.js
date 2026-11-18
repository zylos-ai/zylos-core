import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dateInTimeZone, BUDGETS, WARN_THRESHOLDS, ZYLOS_DIR, MEMORY_DIR, SESSIONS_DIR } from '../shared.js';
import path from 'path';

// ---------------------------------------------------------------------------
// dateInTimeZone
// ---------------------------------------------------------------------------
describe('dateInTimeZone', () => {
  it('formats a known date in UTC', () => {
    const date = new Date('2025-06-15T12:00:00Z');
    const result = dateInTimeZone(date, 'UTC');
    assert.equal(result, '2025-06-15');
  });

  it('formats date correctly across day boundary with timezone', () => {
    // 2025-06-15 01:00 UTC  =>  2025-06-14 in Pacific (UTC-7 in June)
    const date = new Date('2025-06-15T01:00:00Z');
    const result = dateInTimeZone(date, 'America/Los_Angeles');
    assert.equal(result, '2025-06-14');
  });

  it('formats date in Asia/Tokyo timezone', () => {
    // 2025-06-15 20:00 UTC  =>  2025-06-16 05:00 in Tokyo (UTC+9)
    const date = new Date('2025-06-15T20:00:00Z');
    const result = dateInTimeZone(date, 'Asia/Tokyo');
    assert.equal(result, '2025-06-16');
  });

  it('falls back to local date when tz is null', () => {
    const date = new Date('2025-03-01T12:00:00Z');
    const result = dateInTimeZone(date, null);
    // Should return a valid YYYY-MM-DD string (local)
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to local date when tz is undefined', () => {
    const date = new Date('2025-03-01T12:00:00Z');
    const result = dateInTimeZone(date, undefined);
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to local date when tz is empty string', () => {
    const date = new Date('2025-03-01T12:00:00Z');
    const result = dateInTimeZone(date, '');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to local date for invalid timezone', () => {
    const date = new Date('2025-03-01T12:00:00Z');
    const result = dateInTimeZone(date, 'Invalid/Timezone');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('pads single-digit month and day', () => {
    const date = new Date('2025-01-05T12:00:00Z');
    const result = dateInTimeZone(date, 'UTC');
    assert.equal(result, '2025-01-05');
  });

  it('handles year boundary', () => {
    // Dec 31 23:00 UTC => Jan 1 in Tokyo
    const date = new Date('2025-12-31T23:00:00Z');
    const result = dateInTimeZone(date, 'Asia/Tokyo');
    assert.equal(result, '2026-01-01');
  });
});

// ---------------------------------------------------------------------------
// BUDGETS
// ---------------------------------------------------------------------------
describe('BUDGETS', () => {
  it('contains identity.md budget', () => {
    assert.ok(BUDGETS['identity.md'].maxChars > 0);
    assert.ok(BUDGETS['identity.md'].maxTokens > 0);
  });

  it('does not impose a state.md budget', () => {
    assert.equal(BUDGETS['state.md'], undefined);
  });

  it('contains references.md budget', () => {
    assert.deepEqual(BUDGETS['references.md'], BUDGETS['identity.md']);
  });

  it('budgets only the startup files and reference indexes', () => {
    assert.deepEqual(Object.keys(BUDGETS).sort(), ['identity.md', 'reference/decisions/INDEX.md', 'reference/projects/INDEX.md', 'references.md']);
  });

  it('budget values have positive limits', () => {
    for (const [key, value] of Object.entries(BUDGETS)) {
      if (typeof value === 'number') assert.ok(value > 0);
      else assert.ok(value.maxChars > 0 && value.maxTokens > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// WARN_THRESHOLDS
// ---------------------------------------------------------------------------
describe('WARN_THRESHOLDS', () => {
  it('warns for both startup files at 80% of each limit', () => {
    for (const name of ['identity.md', 'references.md']) {
      assert.equal(WARN_THRESHOLDS[name].chars, BUDGETS[name].maxChars * 0.8);
      assert.equal(WARN_THRESHOLDS[name].estimatedTokens, BUDGETS[name].maxTokens * 0.8);
    }
  });

  it('does not warn on state.md size', () => {
    assert.equal(WARN_THRESHOLDS['state.md'], undefined);
  });

  it('every warn threshold is below its hard budget', () => {
    for (const [key, value] of Object.entries(WARN_THRESHOLDS)) {
      assert.ok(BUDGETS[key] !== undefined, `${key} must also have a hard budget`);
      if (typeof value === 'number') assert.ok(value < BUDGETS[key]);
      else assert.ok(value.chars < BUDGETS[key].maxChars && value.estimatedTokens < BUDGETS[key].maxTokens);
    }
  });
});

// ---------------------------------------------------------------------------
// Directory constants
// ---------------------------------------------------------------------------
describe('directory constants', () => {
  it('ZYLOS_DIR defaults to ~/zylos when ZYLOS_DIR env is not set', () => {
    // The constant is evaluated at import time using process.env.ZYLOS_DIR
    // We just verify the shape is correct
    assert.equal(typeof ZYLOS_DIR, 'string');
    assert.ok(ZYLOS_DIR.length > 0);
  });

  it('MEMORY_DIR is ZYLOS_DIR/memory', () => {
    assert.equal(MEMORY_DIR, path.join(ZYLOS_DIR, 'memory'));
  });

  it('SESSIONS_DIR is MEMORY_DIR/sessions', () => {
    assert.equal(SESSIONS_DIR, path.join(MEMORY_DIR, 'sessions'));
  });
});
