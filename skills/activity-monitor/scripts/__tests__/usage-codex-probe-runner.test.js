import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCodexStatusProbePane } from '../usage-codex-probe-runner.js';

describe('usage-codex-probe-runner', () => {
  it('classifies panel status as success', () => {
    const pane = [
      'Context window: 32% left (180K used / 258K)',
      '5h limit: 94% left (resets 21:07)',
      'Weekly limit: 60% left (resets 15:02 on 1 Apr)'
    ].join('\n');

    const result = classifyCodexStatusProbePane(pane);
    assert.equal(result.ok, true);
    assert.equal(result.status.statusShape, 'panel');
    assert.equal(result.status.sessionPercent, 68);
  });

  it('classifies statusline output as success', () => {
    const pane = 'gpt-5.3-codex high · 100% left · ~/zylos';
    const result = classifyCodexStatusProbePane(pane);

    assert.equal(result.ok, true);
    assert.equal(result.status.statusShape, 'statusline');
    assert.equal(result.status.sessionPercent, 0);
  });

  it('classifies unrelated pane as parse_failed', () => {
    const result = classifyCodexStatusProbePane('hello world');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'parse_failed');
  });
});
