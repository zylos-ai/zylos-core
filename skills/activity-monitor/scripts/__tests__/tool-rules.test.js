import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findMatchingToolRule,
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

});
