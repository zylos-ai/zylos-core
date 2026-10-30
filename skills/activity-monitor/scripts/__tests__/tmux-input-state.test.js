import test from 'node:test';
import assert from 'node:assert/strict';
import {findPromptY,isUsageOverlayCapture} from '../../../../cli/lib/tmux-input-state.js';

test('dispatcher prompt and usage overlay checks remain available',()=>{
 assert.equal(findPromptY('answer\n❯ input\n'),1);
 assert.equal(findPromptY('no prompt here'),-1);
 assert.equal(isUsageOverlayCapture('Settings: Status Config Usage\nEsc to cancel'),true);
 assert.equal(isUsageOverlayCapture('❯ regular input'),false);
});
