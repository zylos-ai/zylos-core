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

  it('summarizes Bash by command head', () => {
    const summary = summarizeToolInput('Bash', {
      command: 'npm test --coverage'
    });

    assert.deepEqual(summary, { type: 'command-head', value: 'npm' });
  });

  it('returns input-keys for unknown tools', () => {
    const summary = summarizeToolInput('Read', { file_path: '/tmp/foo' });
    assert.equal(summary.type, 'input-keys');
    assert.deepEqual(summary.value, ['file_path']);
  });

  it('handles invalid URL gracefully with url-preview', () => {
    const summary = summarizeToolInput('WebFetch', { url: 'not-a-valid-url' });
    assert.equal(summary.type, 'url-preview');
    assert.equal(summary.value, 'not-a-valid-url');
  });

  it('returns input-keys when WebFetch url is missing', () => {
    const summary = summarizeToolInput('WebFetch', { prompt: 'summarize' });
    assert.equal(summary.type, 'input-keys');
    assert.deepEqual(summary.value, ['prompt']);
  });

  it('matches WebSearch to the watchdog rule', () => {
    const rule = findMatchingToolRule({
      runtimeId: 'claude',
      toolName: 'WebSearch',
      toolInput: { query: 'test' }
    });
    assert.equal(rule?.id, 'web-tools-timeout');
  });

  it('returns null for null toolName', () => {
    const rule = findMatchingToolRule({ runtimeId: 'claude', toolName: null });
    assert.equal(rule, null);
  });

  it('disables watchdog for non-claude runtime', () => {
    const [rule] = getToolRules({ runtimeId: 'codex' });
    assert.equal(rule.watchdog.enabled, false);
  });

  it('applies config overrides for timeout values', () => {
    const [rule] = getToolRules({
      runtimeId: 'claude',
      config: {
        web_tool_timeout_sec: 600,
        web_tool_interrupt_grace_sec: 30,
        web_tool_timeout_cooldown_sec: 120
      }
    });

    assert.equal(rule.watchdog.maxRuntimeSec, 600);
    assert.equal(rule.watchdog.interruptGraceSec, 30);
    assert.equal(rule.watchdog.cooldownSec, 120);
  });

  it('falls back to defaults for invalid config values', () => {
    const [rule] = getToolRules({
      runtimeId: 'claude',
      config: {
        web_tool_timeout_sec: -5,
        web_tool_interrupt_grace_sec: 'abc'
      }
    });

    assert.equal(rule.watchdog.maxRuntimeSec, 3600);
    assert.equal(rule.watchdog.interruptGraceSec, 15);
  });

  it('uses prompt field as fallback for WebSearch query', () => {
    const summary = summarizeToolInput('WebSearch', { prompt: 'fallback query' });
    assert.deepEqual(summary, { type: 'query-preview', value: 'fallback query' });
  });
});
