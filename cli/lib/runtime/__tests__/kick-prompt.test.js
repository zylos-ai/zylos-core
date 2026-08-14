import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildKickPrompt } from '../kick-prompt.js';

describe('kick-prompt (#743/#745 stateless internal sentinel)', () => {
  // The exact contract string, duplicated deliberately: changing the kick
  // wording must be a conscious act that edits this test too.
  const EXACT_KICK =
    'System startup trigger, not a user message. Continue with startup context.';

  it('is exactly the agreed one-sentence contract text', () => {
    assert.equal(buildKickPrompt(), EXACT_KICK);
  });

  it('is a stable constant — no state, no per-launch variance', () => {
    assert.equal(buildKickPrompt(), buildKickPrompt());
  });

  it('self-identifies as non-human', () => {
    assert.match(buildKickPrompt(), /not a user message/);
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
