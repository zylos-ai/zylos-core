import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCodexStatusFromPane } from '../usage-codex-status-parser.js';

describe('usage-codex-status-parser', () => {
  it('parses panel mode fields and converts left->used', () => {
    const pane = [
      'Context window: 32% left (180K used / 258K)',
      '5h limit: 94% left (resets 21:07)',
      'Weekly limit: 60% left (resets 15:02 on 1 Apr)'
    ].join('\n');

    const result = parseCodexStatusFromPane(pane);
    assert.equal(result.statusShape, 'panel');
    assert.equal(result.sessionPercent, 68);
    assert.equal(result.fiveHourPercent, 6);
    assert.equal(result.fiveHourResets, '21:07');
    assert.equal(result.weeklyAllPercent, 40);
    assert.equal(result.weeklyAllResets, '15:02 on 1 Apr');
  });

  it('parses compact statusline mode', () => {
    const pane = 'gpt-5.3-codex high · 47% left · ~/zylos';
    const result = parseCodexStatusFromPane(pane);

    assert.equal(result.statusShape, 'statusline');
    assert.equal(result.sessionPercent, 53);
    assert.equal(result.weeklyAllPercent, null);
    assert.equal(result.fiveHourPercent, null);
  });

  it('returns null for unrelated pane', () => {
    assert.equal(parseCodexStatusFromPane('hello world'), null);
  });
});
