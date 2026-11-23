import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildKickPrompt } from '../kick-prompt.js';

describe('kick-prompt (#743/#745 stateless internal sentinel)', () => {

  it('self-identifies as non-human', () => {
    assert.match(buildKickPrompt(), /not a user message/);
  });

});
