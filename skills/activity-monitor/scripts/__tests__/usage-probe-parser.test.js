import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUsageFromPane } from '../usage-probe-parser.js';

describe('usage-probe-parser', () => {
  it('parses session and weekly usage fields', () => {
    const pane = [
      'Current session',
      '15% used',
      'Current week (all models)',
      '63% used',
      'Current week (Sonnet 4)',
      '22% used',
      'Resets in 2h',
      'Resets Friday 7am',
      'Resets Friday 7am'
    ].join('\n');

    const result = parseUsageFromPane(pane);

    assert.equal(result.session, 15);
    assert.equal(result.weeklyAll, 63);
    assert.equal(result.weeklySonnet, 22);
    assert.equal(result.sessionResets, 'in 2h');
    assert.equal(result.weeklyAllResets, 'Friday 7am');
  });

  it('returns null when no usage block exists', () => {
    const result = parseUsageFromPane('hello world');
    assert.equal(result, null);
  });
});
