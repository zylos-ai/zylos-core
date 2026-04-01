import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectCodexLimitFromPane } from '../heartbeat/codex-probe.js';

describe('codex-probe detectCodexLimitFromPane', () => {
  it('detects usage limit with reset time across two lines', () => {
    const pane = [
      '■ You\'ve hit your usage limit. To get more access now, send a request to your admin or try again at Apr 2nd, 2026',
      '2:41 AM.',
      '',
      '› Summarize recent commits',
      '',
      '  gpt-5.4 default · 26% left · ~/zylos'
    ].join('\n');

    const result = detectCodexLimitFromPane(pane);
    assert.equal(result.detected, true);
    assert.equal(result.reason, 'codex_usage_limit');
    assert.match(result.resetTime, /Apr 2nd, 2026.*2:41 AM/);
    assert.ok(result.cooldownUntil > Math.floor(Date.now() / 1000));
    assert.match(result.detail, /usage limit/i);
  });

  it('detects usage limit with smart quotes', () => {
    const result = detectCodexLimitFromPane(
      'You\u2019ve hit your usage limit. To get more access now, send a request to your admin.'
    );
    assert.equal(result.detected, true);
    assert.equal(result.reason, 'codex_usage_limit');
  });

  it('ignores unrelated pane text', () => {
    const result = detectCodexLimitFromPane('All good. Codex is waiting for input.');
    assert.deepStrictEqual(result, { detected: false });
  });

  it('ignores usage limit text quoted in conversation', () => {
    // Conversation content that merely discusses the limit text should not trigger detection
    const pane = 'User: What does "You\'ve hit your usage limit" mean?\nAssistant: It means your quota is exhausted.';
    const result = detectCodexLimitFromPane(pane);
    assert.deepStrictEqual(result, { detected: false });
  });
});
