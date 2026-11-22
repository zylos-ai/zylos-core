import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findMatchingToolRule,
  getToolRules,
} from '../tool-rules.js';

const watchdog = (await getRuntime('claude')).health.toolWatchdog;

describe('tool-rules', () => {
  it('matches watchdog rule for WebFetch and WebSearch only', () => {
    const webRule = findMatchingToolRule({
      runtimeId: 'claude',
      watchdog,
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com' }
    });
    const bashRule = findMatchingToolRule({
      runtimeId: 'claude',
      watchdog,
      toolName: 'Bash',
      toolInput: { command: 'npm test' }
    });

    assert.equal(webRule?.id, 'web-tools-timeout');
    assert.equal(bashRule, null);
  });

  it('allows watchdog disable via config while preserving the rule shape', () => {
    const [rule] = getToolRules({
      runtimeId: 'claude',
      watchdog,
      config: { web_tool_watchdog_enabled: false }
    });

    assert.equal(rule.id, 'web-tools-timeout');
    assert.equal(rule.watchdog.enabled, false);
  });

  it('matches WebSearch to the watchdog rule', () => {
    const rule = findMatchingToolRule({
      runtimeId: 'claude',
      watchdog,
      toolName: 'WebSearch',
      toolInput: { query: 'test' }
    });
    assert.equal(rule?.id, 'web-tools-timeout');
  });

  it('returns null for null toolName', () => {
    const rule = findMatchingToolRule({ runtimeId: 'claude', toolName: null });
    assert.equal(rule, null);
  });

  it('disables watchdog for non-claude runtime', async () => {
    const { health } = await getRuntime('codex');
    assert.equal(findMatchingToolRule({ runtimeId: 'codex', watchdog: health.toolWatchdog, toolName: 'WebFetch' }), null);
  });

  it('applies config overrides for timeout values', () => {
    const [rule] = getToolRules({
      runtimeId: 'claude',
      watchdog,
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
      watchdog,
      config: {
        web_tool_timeout_sec: -5,
        web_tool_interrupt_grace_sec: 'abc'
      }
    });

    assert.equal(rule.watchdog.maxRuntimeSec, 3600);
    assert.equal(rule.watchdog.interruptGraceSec, 15);
  });
});
