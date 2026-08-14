import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SENTINEL_PREFIX, buildKickPrompt } from '../kick-prompt.js';

describe('kick-prompt (#743/#745 stateless internal sentinel)', () => {
  it('is a stable constant — no state, no per-launch variance', () => {
    assert.equal(buildKickPrompt(), buildKickPrompt());
  });

  it('starts with the internal sentinel prefix and self-identifies as non-human', () => {
    const prompt = buildKickPrompt();
    assert.ok(prompt.startsWith(SENTINEL_PREFIX));
    assert.match(prompt, /not a user message/);
  });

  it('stays one short sentence and claims no lifecycle knowledge (#743)', () => {
    const prompt = buildKickPrompt();
    assert.doesNotMatch(prompt, /lifecycle=/);
    assert.ok(prompt.length <= 160,
      'kick must stay minimal — guidance belongs to the hook-injected context');
  });

  it('never uses human-greeting wording (regression: #745 route misattribution)', () => {
    const prompt = buildKickPrompt();
    assert.doesNotMatch(prompt, /\bhello\b/i);
    assert.doesNotMatch(prompt, /welcome back/i);
  });

  it('stays shell-safe for double-quoted interpolation', () => {
    assert.doesNotMatch(buildKickPrompt(), /["$\\`\n]/);
  });
});
