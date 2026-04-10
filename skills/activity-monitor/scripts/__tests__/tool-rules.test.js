import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findMatchingToolRule,
  getToolRules,
  summarizeToolInput,
} from '../tool-rules.js';

describe('tool-rules', () => {
  it('summarizes WebFetch by host', () => {
    const summary = summarizeToolInput('WebFetch', {
      url: 'https://webcache.googleusercontent.com/search?q=test'
    });

    assert.deepEqual(summary, {
      type: 'url-host',
      value: 'webcache.googleusercontent.com'
    });
  });

  it('summarizes WebSearch by query preview', () => {
    const summary = summarizeToolInput('WebSearch', {
      query: 'latest claude code hook docs'
    });

    assert.deepEqual(summary, {
      type: 'query-preview',
      value: 'latest claude code hook docs'
    });
  });

  it('matches watchdog rule for WebFetch and WebSearch only', () => {
    const webRule = findMatchingToolRule({
      runtimeId: 'claude',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com' }
    });
    const bashRule = findMatchingToolRule({
      runtimeId: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'npm test' }
    });

    assert.equal(webRule?.id, 'web-tools-timeout');
    assert.equal(bashRule, null);
  });

  it('allows watchdog disable via config while preserving the rule shape', () => {
    const [rule] = getToolRules({
      runtimeId: 'claude',
      config: { web_tool_watchdog_enabled: false }
    });

    assert.equal(rule.id, 'web-tools-timeout');
    assert.equal(rule.watchdog.enabled, false);
  });
});
